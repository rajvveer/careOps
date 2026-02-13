const prisma = require('../lib/prisma');

class SmsService {
    /**
     * Resolve SMS config: workspace Integration.config > env vars > defaults
     */
    async getConfig(workspaceId) {
        try {
            const integration = await prisma.integration.findFirst({
                where: { workspaceId, type: 'SMS', isActive: true }
            });
            const cfg = integration?.config || {};
            return {
                apiKey: cfg.apiKey || process.env.BREVO_API_KEY,
                senderName: cfg.senderName || 'CareOps'
            };
        } catch {
            return {
                apiKey: process.env.BREVO_API_KEY,
                senderName: 'CareOps'
            };
        }
    }

    async send(workspaceId, { to, body }) {
        try {
            const config = await this.getConfig(workspaceId);
            const apiKey = config.apiKey;

            // Try Brevo SMS first
            if (apiKey && apiKey !== 'your-brevo-api-key-here') {
                const response = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'api-key': apiKey,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        type: 'transactional',
                        unicodeEnabled: true,
                        sender: config.senderName,
                        recipient: to,
                        content: body
                    })
                });

                const result = await response.json();

                if (response.ok) {
                    console.log('✅ SMS sent via Brevo to:', to);
                    await this.log(workspaceId, 'sms_sent', { to, reference: result.reference });
                    return { success: true, reference: result.reference };
                } else {
                    console.log('⚠️ Brevo SMS failed, using in-app notification:', result.message);
                    // Fall through to in-app notification
                }
            }

            // Fallback: In-app notification (always works, free)
            console.log('📱 [IN-APP] SMS notification logged for:', to);
            console.log('   Content:', body);

            // Create an in-app alert so staff can see it
            await prisma.alert.create({
                data: {
                    workspaceId,
                    type: 'SYSTEM',
                    message: `📱 SMS to ${to}: ${body}`,
                    link: '/inbox'
                }
            });

            await this.log(workspaceId, 'sms_inapp_notification', { to, body });
            return { success: true, method: 'in-app', message: 'Delivered as in-app notification' };
        } catch (error) {
            console.error('SMS send error:', error.message);
            await this.log(workspaceId, 'sms_failed', { to, error: error.message }, 'failed');
            return { success: false, error: error.message };
        }
    }

    async log(workspaceId, event, details, status = 'success') {
        try {
            await prisma.automationLog.create({
                data: {
                    workspaceId,
                    event,
                    action: 'send_sms',
                    status,
                    details: JSON.stringify(details)
                }
            });
        } catch (err) {
            console.error('Failed to log SMS:', err.message);
        }
    }
}

module.exports = new SmsService();
