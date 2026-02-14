const cron = require('node-cron');
const prisma = require('../lib/prisma');
const emailService = require('./email');
const whatsappService = require('./whatsapp');

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
                await whatsappService.send(booking.workspaceId, { to: booking.contact.phone, body: reminderMsg });
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
                const formUrl = `${process.env.FRONTEND_URL}/public/${submission.formTemplate.workspaceId}/form/${submission.formTemplateId}`;
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

// ─── Daily Booking Summary for Owner & Staff (runs at 7 AM) ────
cron.schedule('0 7 * * *', async () => {
    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const todaysBookings = await prisma.booking.findMany({
            where: {
                status: 'CONFIRMED',
                dateTime: { gte: startOfDay, lte: endOfDay }
            },
            include: {
                contact: true,
                serviceType: true,
                workspace: true
            },
            orderBy: { dateTime: 'asc' }
        });

        if (todaysBookings.length === 0) {
            console.log('📅 No bookings today — skipping daily summary.');
            return;
        }

        // Group bookings by workspace
        const byWorkspace = {};
        for (const b of todaysBookings) {
            if (!byWorkspace[b.workspaceId]) byWorkspace[b.workspaceId] = [];
            byWorkspace[b.workspaceId].push(b);
        }

        for (const [workspaceId, bookings] of Object.entries(byWorkspace)) {
            // Avoid duplicate summary emails
            const alreadySent = await prisma.automationLog.findFirst({
                where: {
                    workspaceId,
                    event: 'booking.daily_summary',
                    createdAt: { gte: startOfDay }
                }
            });
            if (alreadySent) continue;

            // Get owner + staff emails
            const users = await prisma.user.findMany({
                where: { workspaceId },
                select: { email: true, name: true, role: true }
            });

            if (users.length === 0) continue;

            const workspace = bookings[0].workspace;
            const count = bookings.length;

            // Build HTML email
            const rows = bookings.map(b => {
                const time = new Date(b.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return `<tr>
                    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px">${time}</td>
                    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px">${b.serviceType.name}</td>
                    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px">${b.contact.name || 'N/A'}</td>
                    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:14px">${b.contact.email || b.contact.phone || '—'}</td>
                </tr>`;
            }).join('');

            const dateStr = startOfDay.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

            const html = `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                    <h2 style="color:#4f46e5;margin-bottom:4px">📅 Today's Bookings</h2>
                    <p style="color:#6b7280;margin-top:0">${dateStr} · ${count} appointment${count > 1 ? 's' : ''}</p>
                    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
                        <thead>
                            <tr style="background:#f9fafb">
                                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase">Time</th>
                                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase">Service</th>
                                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase">Client</th>
                                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280;text-transform:uppercase">Contact</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <p style="color:#9ca3af;font-size:12px;margin-top:16px">— ${workspace.name} via CareOps</p>
                </div>`;

            const textSummary = bookings.map(b => {
                const time = new Date(b.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return `• ${time} — ${b.serviceType.name} with ${b.contact.name || 'N/A'}`;
            }).join('\n');

            // Send to each user
            for (const user of users) {
                await emailService.send(workspaceId, {
                    to: user.email,
                    subject: `📅 ${count} booking${count > 1 ? 's' : ''} today — ${dateStr}`,
                    text: `Today's bookings for ${workspace.name}:\n\n${textSummary}`,
                    html
                });
            }

            await prisma.automationLog.create({
                data: {
                    workspaceId,
                    event: 'booking.daily_summary',
                    action: 'send_daily_summary',
                    status: 'success',
                    details: JSON.stringify({ count, recipients: users.length })
                }
            });
        }

        console.log(`📅 Daily booking summary sent for ${Object.keys(byWorkspace).length} workspace(s).`);
    } catch (error) {
        console.error('Cron error (daily booking summary):', error);
    }
});

console.log('⏰ Cron jobs scheduled: booking reminders, form overdue, inventory check, daily summary');

module.exports = {};
