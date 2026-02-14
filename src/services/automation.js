const prisma = require('../lib/prisma');
const emailService = require('./email');
const whatsappService = require('./whatsapp');
const calendarService = require('./calendar');
const webhookService = require('./webhook');

class AutomationService {
    // ─── Helper: Notify owner + staff via email ──────────
    async notifyTeam(workspaceId, { subject, text, html }) {
        try {
            // Get owner
            const owner = await prisma.user.findFirst({
                where: { workspaceId, role: 'OWNER' }
            });

            // Get all staff
            const staff = await prisma.user.findMany({
                where: { workspaceId, role: 'STAFF' }
            });

            const recipients = [];
            if (owner) recipients.push(owner);
            recipients.push(...staff);

            // Send email to each team member
            for (const member of recipients) {
                if (member.email) {
                    await emailService.send(workspaceId, {
                        to: member.email,
                        subject,
                        text,
                        html
                    });
                }
            }

            console.log(`📧 Team notified (${recipients.length} members) - ${subject}`);
        } catch (error) {
            console.error('Failed to notify team:', error.message);
        }
    }

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

                // Send welcome to contact via email
                if (contact.email) {
                    await emailService.send(workspaceId, {
                        to: contact.email,
                        subject: `Welcome to ${workspace.name}!`,
                        text: welcomeMsg,
                        html: `<p>${welcomeMsg}</p>`
                    });
                }

                // Send welcome to contact via WhatsApp
                if (contact.phone) {
                    await whatsappService.send(workspaceId, { to: contact.phone, body: welcomeMsg });
                }
            }

            // ── Notify business owner + staff about the new contact ──
            await this.notifyTeam(workspaceId, {
                subject: `📩 New Contact: ${contact.name}`,
                text: `You have a new contact!\n\nName: ${contact.name}\nEmail: ${contact.email || 'Not provided'}\nPhone: ${contact.phone || 'Not provided'}\nSource: Contact Form\n\nView in inbox: ${process.env.FRONTEND_URL}/inbox`,
                html: `
                    <h2>📩 New Contact Message</h2>
                    <table style="border-collapse:collapse;width:100%;max-width:500px;">
                        <tr><td style="padding:8px;font-weight:bold;color:#555;">Name</td><td style="padding:8px;">${contact.name}</td></tr>
                        <tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Email</td><td style="padding:8px;">${contact.email || 'Not provided'}</td></tr>
                        <tr><td style="padding:8px;font-weight:bold;color:#555;">Phone</td><td style="padding:8px;">${contact.phone || 'Not provided'}</td></tr>
                    </table>
                    <p style="margin-top:16px;"><a href="${process.env.FRONTEND_URL}/inbox" style="background:#4F46E5;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">View in Inbox →</a></p>
                `
            });

            // Create in-app alert for new contact message
            await prisma.alert.create({
                data: {
                    workspaceId,
                    type: 'MISSED_MESSAGE',
                    message: `New message from ${contact.name}${contact.email ? ` (${contact.email})` : ''}`,
                    link: '/inbox'
                }
            });

            await this.log(workspaceId, 'contact.created', 'send_welcome', contact.id);
            // Fire webhooks
            await webhookService.fire(workspaceId, 'contact.created', {
                id: contact.id, name: contact.name, email: contact.email, phone: contact.phone
            });
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

            // Send confirmation to contact via email
            if (contact.email) {
                await emailService.send(workspaceId, {
                    to: contact.email,
                    subject: `Booking Confirmed - ${serviceType.name}`,
                    text: confirmMsg,
                    html: `<h2>Booking Confirmed!</h2><p>${confirmMsg}</p>`
                });
            }

            // Send confirmation to contact via WhatsApp
            if (contact.phone) {
                await whatsappService.send(workspaceId, { to: contact.phone, body: confirmMsg });
            }

            // ── Notify business owner + staff about the new booking ──
            const dateStr2 = new Date(booking.dateTime).toLocaleString();
            const endStr = new Date(booking.endTime).toLocaleTimeString();
            await this.notifyTeam(workspaceId, {
                subject: `📅 New Booking: ${contact.name} - ${serviceType.name}`,
                text: `New booking received!\n\nClient: ${contact.name}\nEmail: ${contact.email || 'N/A'}\nPhone: ${contact.phone || 'N/A'}\nService: ${serviceType.name}\nDate: ${dateStr2}\nEnd: ${endStr}\n${serviceType.location ? `Location: ${serviceType.location}` : ''}\n\nView bookings: ${process.env.FRONTEND_URL}/bookings`,
                html: `
                    <h2>📅 New Booking Received</h2>
                    <table style="border-collapse:collapse;width:100%;max-width:500px;">
                        <tr><td style="padding:8px;font-weight:bold;color:#555;">Client</td><td style="padding:8px;">${contact.name}</td></tr>
                        <tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Email</td><td style="padding:8px;">${contact.email || 'N/A'}</td></tr>
                        <tr><td style="padding:8px;font-weight:bold;color:#555;">Phone</td><td style="padding:8px;">${contact.phone || 'N/A'}</td></tr>
                        <tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Service</td><td style="padding:8px;">${serviceType.name}</td></tr>
                        <tr><td style="padding:8px;font-weight:bold;color:#555;">Date/Time</td><td style="padding:8px;">${dateStr2}</td></tr>
                        <tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Duration</td><td style="padding:8px;">${serviceType.duration} minutes</td></tr>
                        ${serviceType.location ? `<tr><td style="padding:8px;font-weight:bold;color:#555;">Location</td><td style="padding:8px;">${serviceType.location}</td></tr>` : ''}
                        ${serviceType.price ? `<tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Price</td><td style="padding:8px;">$${serviceType.price}</td></tr>` : ''}
                    </table>
                    <p style="margin-top:16px;"><a href="${process.env.FRONTEND_URL}/bookings" style="background:#4F46E5;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">View Bookings →</a></p>
                `
            });

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
                    const formParams = new URLSearchParams({ name: contact.name || '', email: contact.email || '', phone: contact.phone || '' }).toString();
                    const formUrl = `${process.env.FRONTEND_URL}/public/${workspaceId}/form/${template.id}?${formParams}`;
                    await emailService.send(workspaceId, {
                        to: contact.email,
                        subject: `Please complete: ${template.name}`,
                        text: `Please complete the form "${template.name}" before your appointment. Link: ${formUrl}`,
                        html: `<p>Please complete the form <strong>${template.name}</strong> before your appointment.</p><p><a href="${formUrl}">Fill out form</a></p>`
                    });
                }
            }

            // Create in-app alert for new booking
            await prisma.alert.create({
                data: {
                    workspaceId,
                    type: 'UNCONFIRMED_BOOKING',
                    message: `New booking: ${contact.name} booked ${serviceType.name} for ${dateStr2}`,
                    link: '/bookings'
                }
            });

            // Sync to Google Calendar
            const fullBooking = await prisma.booking.findUnique({
                where: { id: booking.id },
                include: { contact: true, serviceType: true }
            });
            await calendarService.createEvent(workspaceId, fullBooking);

            // Fire webhooks
            await webhookService.fire(workspaceId, 'booking.created', {
                id: booking.id, dateTime: booking.dateTime, contactId: contact.id, contactName: contact.name
            });

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

            // Notify owner + staff via email
            await this.notifyTeam(workspaceId, {
                subject: `⚠️ Low Inventory Alert: ${item.name}`,
                text: `${item.name} is running low. Current: ${item.quantity} ${item.unit}. Threshold: ${item.threshold}.`,
                html: `<h3>⚠️ Low Inventory Alert</h3><p><strong>${item.name}</strong> is running low.</p><p>Current: ${item.quantity} ${item.unit}<br>Threshold: ${item.threshold}</p>`
            });

            // Fire webhooks
            await webhookService.fire(workspaceId, 'inventory.low', {
                id: item.id, name: item.name, quantity: item.quantity, threshold: item.threshold
            });

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
