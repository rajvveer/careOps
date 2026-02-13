const prisma = require('../lib/prisma');

class EmailService {
    /**
     * Resolve email config: workspace Integration.config > env vars > defaults
     */
    async getConfig(workspaceId) {
        try {
            const integration = await prisma.integration.findFirst({
                where: { workspaceId, type: 'EMAIL', isActive: true }
            });
            const cfg = integration?.config || {};
            return {
                apiKey: cfg.apiKey || process.env.BREVO_API_KEY,
                senderName: cfg.senderName || process.env.BREVO_SENDER_NAME,
                senderEmail: cfg.senderEmail || process.env.BREVO_SENDER_EMAIL
            };
        } catch {
            return {
                apiKey: process.env.BREVO_API_KEY,
                senderName: process.env.BREVO_SENDER_NAME,
                senderEmail: process.env.BREVO_SENDER_EMAIL
            };
        }
    }

    async send(workspaceId, { to, subject, text, html }) {
        try {
            const config = await this.getConfig(workspaceId);
            const apiKey = config.apiKey;

            if (!apiKey || apiKey === 'your-brevo-api-key-here') {
                console.log('📧 [DEMO MODE] Email would be sent to:', to);
                console.log('   Subject:', subject);
                console.log('   Content:', text?.substring(0, 100));
                await this.log(workspaceId, 'email_sent_demo', { to, subject });
                return { success: true, demo: true };
            }

            const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });

            const response = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'api-key': apiKey,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    sender: {
                        name: config.senderName || workspace?.name || 'CareOps',
                        email: config.senderEmail || workspace?.contactEmail || 'noreply@careops.com'
                    },
                    to: [{ email: to }],
                    subject,
                    textContent: text,
                    htmlContent: html || `<p>${text}</p>`
                })
            });

            const result = await response.json();

            if (response.ok) {
                console.log('✅ Email sent via Brevo to:', to);
                await this.log(workspaceId, 'email_sent', { to, subject, messageId: result.messageId });
                return { success: true, messageId: result.messageId };
            } else {
                console.error('❌ Brevo email error:', result);
                await this.log(workspaceId, 'email_failed', { to, subject, error: result.message }, 'failed');
                return { success: false, error: result.message };
            }
        } catch (error) {
            console.error('Email send error:', error.message);
            await this.log(workspaceId, 'email_failed', { to, subject, error: error.message }, 'failed');
            return { success: false, error: error.message };
        }
    }

    async log(workspaceId, event, details, status = 'success') {
        try {
            await prisma.automationLog.create({
                data: {
                    workspaceId,
                    event,
                    action: 'send_email',
                    status,
                    details: JSON.stringify(details)
                }
            });
        } catch (err) {
            console.error('Failed to log email:', err.message);
        }
    }
}

module.exports = new EmailService();
