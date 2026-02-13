const cron = require('node-cron');
const prisma = require('../lib/prisma');
const emailService = require('./email');
const smsService = require('./sms');

// ─── Booking Reminders (runs every hour) ─────────────
cron.schedule('0 * * * *', async () => {
    try {
        const now = new Date();
        const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const upcomingBookings = await prisma.booking.findMany({
            where: {
                status: 'CONFIRMED',
                dateTime: { gte: now, lte: in24Hours }
            },
            include: {
                contact: true,
                serviceType: true,
                workspace: true
            }
        });

        for (const booking of upcomingBookings) {
            const conversation = await prisma.conversation.findFirst({
                where: { contactId: booking.contactId, workspaceId: booking.workspaceId }
            });

            if (conversation?.automationPaused) continue;

            // Check if reminder already sent (avoid duplicates)
            const existing = await prisma.automationLog.findFirst({
                where: {
                    workspaceId: booking.workspaceId,
                    event: 'booking.reminder',
                    contactId: booking.contactId,
                    createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
                }
            });
            if (existing) continue;

            const dateStr = new Date(booking.dateTime).toLocaleString();
            const reminderMsg = `Reminder: Your ${booking.serviceType.name} appointment at ${booking.workspace.name} is coming up on ${dateStr}.`;

            if (booking.contact.email) {
                await emailService.send(booking.workspaceId, {
                    to: booking.contact.email,
                    subject: `Appointment Reminder - ${booking.serviceType.name}`,
                    text: reminderMsg,
                    html: `<p>${reminderMsg}</p>`
                });
            }

            if (booking.contact.phone) {
                await smsService.send(booking.workspaceId, { to: booking.contact.phone, body: reminderMsg });
            }

            if (conversation) {
                await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        direction: 'OUTBOUND',
                        channel: 'SYSTEM',
                        content: reminderMsg
                    }
                });
            }

            await prisma.automationLog.create({
                data: {
                    workspaceId: booking.workspaceId,
                    event: 'booking.reminder',
                    action: 'send_reminder',
                    contactId: booking.contactId,
                    status: 'success'
                }
            });
        }

        console.log(`✅ Booking reminders checked: ${upcomingBookings.length} upcoming`);
    } catch (error) {
        console.error('Cron error (booking reminders):', error);
    }
});

// ─── Form Overdue Check (runs every 6 hours) ─────────
cron.schedule('0 */6 * * *', async () => {
    try {
        const now = new Date();

        // Mark overdue forms
        const overdueSubmissions = await prisma.formSubmission.findMany({
            where: {
                status: 'PENDING',
                dueDate: { lt: now }
            },
            include: {
                contact: true,
                formTemplate: true
            }
        });

        for (const submission of overdueSubmissions) {
            await prisma.formSubmission.update({
                where: { id: submission.id },
                data: { status: 'OVERDUE' }
            });

            // Send reminder
            if (submission.contact.email) {
                const formUrl = `${process.env.FRONTEND_URL}/forms/${submission.id}`;
                await emailService.send(submission.formTemplate.workspaceId, {
                    to: submission.contact.email,
                    subject: `Overdue: Please complete ${submission.formTemplate.name}`,
                    text: `Your form "${submission.formTemplate.name}" is overdue. Please complete it as soon as possible. Link: ${formUrl}`,
                    html: `<p>Your form <strong>${submission.formTemplate.name}</strong> is overdue. Please complete it.</p><p><a href="${formUrl}">Complete form</a></p>`
                });
            }

            // Create alert
            await prisma.alert.create({
                data: {
                    workspaceId: submission.formTemplate.workspaceId,
                    type: 'OVERDUE_FORM',
                    message: `Form "${submission.formTemplate.name}" is overdue for ${submission.contact.name}`,
                    link: `/forms/submissions/${submission.id}`
                }
            });
        }

        console.log(`✅ Form overdue check: ${overdueSubmissions.length} overdue`);
    } catch (error) {
        console.error('Cron error (form overdue):', error);
    }
});

// ─── Inventory Check (runs daily at midnight) ────────
cron.schedule('0 0 * * *', async () => {
    try {

        // Fallback: get all items and filter
        const allItems = await prisma.inventoryItem.findMany({
            include: { workspace: true }
        });

        for (const item of allItems) {
            if (item.quantity <= item.threshold) {
                // Check if alert already exists today
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const existingAlert = await prisma.alert.findFirst({
                    where: {
                        workspaceId: item.workspaceId,
                        type: 'LOW_INVENTORY',
                        createdAt: { gte: today },
                        message: { contains: item.name }
                    }
                });

                if (!existingAlert) {
                    await prisma.alert.create({
                        data: {
                            workspaceId: item.workspaceId,
                            type: 'LOW_INVENTORY',
                            message: `Low stock: ${item.name} has ${item.quantity} ${item.unit} (threshold: ${item.threshold})`,
                            link: `/inventory/${item.id}`
                        }
                    });
                }
            }
        }

        console.log('✅ Inventory check completed');
    } catch (error) {
        console.error('Cron error (inventory):', error);
    }
});

console.log('⏰ Cron jobs scheduled: booking reminders, form overdue, inventory check');

module.exports = {};
