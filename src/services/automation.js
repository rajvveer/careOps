const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const emailService = require('./email');
const smsService = require('./sms');
const calendarService = require('./calendar');

class AutomationService {
    // ─── Contact Created → Welcome Message ───────────────
    async onContactCreated(workspaceId, contact) {
        try {
            const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
            if (!workspace?.isActive) return;

            const welcomeMsg = `Hi ${contact.name}! Thank you for reaching out to ${workspace.name}. We'll get back to you shortly.`;

            // Create system message in conversation
            const conversation = await prisma.conversation.findFirst({
                where: { contactId: contact.id, workspaceId }
            });

            if (conversation && !conversation.automationPaused) {
                await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        direction: 'OUTBOUND',
                        channel: 'SYSTEM',
                        content: welcomeMsg
                    }
                });

                // Send via email if available
                if (contact.email) {
                    await emailService.send(workspaceId, {
                        to: contact.email,
                        subject: `Welcome to ${workspace.name}!`,
                        text: welcomeMsg,
                        html: `<p>${welcomeMsg}</p>`
                    });
                }

                // Send via SMS if available
                if (contact.phone) {
                    await smsService.send(workspaceId, { to: contact.phone, body: welcomeMsg });
                }
            }

            await this.log(workspaceId, 'contact.created', 'send_welcome', contact.id);
        } catch (error) {
            console.error('Automation error (contact.created):', error);
            await this.log(workspaceId, 'contact.created', 'send_welcome', contact.id, 'failed', error.message);
        }
    }

    // ─── Booking Created → Confirmation + Send Forms ─────
    async onBookingCreated(workspaceId, booking, contact) {
        try {
            const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
            const serviceType = await prisma.serviceType.findUnique({ where: { id: booking.serviceTypeId } });
            if (!workspace?.isActive) return;

            const dateStr = new Date(booking.dateTime).toLocaleString();
            const confirmMsg = `Your ${serviceType.name} appointment at ${workspace.name} is confirmed for ${dateStr}. ${serviceType.location ? `Location: ${serviceType.location}` : ''}`;

            // Save confirmation message
            const conversation = await prisma.conversation.findFirst({
                where: { contactId: contact.id, workspaceId }
            });

            if (conversation) {
                await prisma.message.create({
                    data: {
                        conversationId: conversation.id,
                        direction: 'OUTBOUND',
                        channel: 'SYSTEM',
                        content: confirmMsg
                    }
                });
            }

            // Send confirmation
            if (contact.email) {
                await emailService.send(workspaceId, {
                    to: contact.email,
                    subject: `Booking Confirmed - ${serviceType.name}`,
                    text: confirmMsg,
                    html: `<h2>Booking Confirmed!</h2><p>${confirmMsg}</p>`
                });
            }
            if (contact.phone) {
                await smsService.send(workspaceId, { to: contact.phone, body: confirmMsg });
            }

            // Auto-send linked forms
            const formTemplates = await prisma.formTemplate.findMany({
                where: { workspaceId, linkedServiceTypeId: booking.serviceTypeId }
            });

            for (const template of formTemplates) {
                const submission = await prisma.formSubmission.create({
                    data: {
                        formTemplateId: template.id,
                        bookingId: booking.id,
                        contactId: contact.id,
                        status: 'PENDING',
                        dueDate: new Date(booking.dateTime) // due before booking
                    }
                });

                // Notify about forms
                if (contact.email) {
                    const formUrl = `${process.env.FRONTEND_URL}/forms/${submission.id}`;
                    await emailService.send(workspaceId, {
                        to: contact.email,
                        subject: `Please complete: ${template.name}`,
                        text: `Please complete the form "${template.name}" before your appointment. Link: ${formUrl}`,
                        html: `<p>Please complete the form <strong>${template.name}</strong> before your appointment.</p><p><a href="${formUrl}">Fill out form</a></p>`
                    });
                }
            }

            // Sync to Google Calendar
            const fullBooking = await prisma.booking.findUnique({
                where: { id: booking.id },
                include: { contact: true, serviceType: true }
            });
            await calendarService.createEvent(workspaceId, fullBooking);

            await this.log(workspaceId, 'booking.created', 'send_confirmation', contact.id);
        } catch (error) {
            console.error('Automation error (booking.created):', error);
            await this.log(workspaceId, 'booking.created', 'send_confirmation', contact.id, 'failed', error.message);
        }
    }

    // ─── Staff Reply → Pause Automation ──────────────────
    async onStaffReply(workspaceId, conversationId) {
        try {
            await prisma.conversation.update({
                where: { id: conversationId },
                data: { automationPaused: true }
            });
            await this.log(workspaceId, 'staff.replied', 'pause_automation', null);
        } catch (error) {
            console.error('Automation error (staff.replied):', error);
        }
    }

    // ─── Inventory Low → Alert ───────────────────────────
    async onInventoryLow(workspaceId, item) {
        try {
            await prisma.alert.create({
                data: {
                    workspaceId,
                    type: 'LOW_INVENTORY',
                    message: `Low stock alert: ${item.name} has only ${item.quantity} ${item.unit} remaining (threshold: ${item.threshold})`,
                    link: `/inventory/${item.id}`
                }
            });

            // Notify owner via email
            const owner = await prisma.user.findFirst({
                where: { workspaceId, role: 'OWNER' }
            });
            if (owner) {
                await emailService.send(workspaceId, {
                    to: owner.email,
                    subject: `⚠️ Low Inventory Alert: ${item.name}`,
                    text: `${item.name} is running low. Current: ${item.quantity} ${item.unit}. Threshold: ${item.threshold}.`,
                    html: `<h3>⚠️ Low Inventory Alert</h3><p><strong>${item.name}</strong> is running low.</p><p>Current: ${item.quantity} ${item.unit}<br>Threshold: ${item.threshold}</p>`
                });
            }

            await this.log(workspaceId, 'inventory.low', 'create_alert', null);
        } catch (error) {
            console.error('Automation error (inventory.low):', error);
        }
    }

    // ─── Log automation events ───────────────────────────
    async log(workspaceId, event, action, contactId, status = 'success', details = null) {
        try {
            await prisma.automationLog.create({
                data: { workspaceId, event, action, contactId, status, details }
            });
        } catch (err) {
            console.error('Failed to log automation:', err);
        }
    }
}

module.exports = new AutomationService();
