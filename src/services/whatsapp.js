const prisma = require('../lib/prisma');

class WhatsAppService {
    /**
     * Resolve WhatsApp config: workspace Integration.config > env vars > defaults
     */
    async getConfig(workspaceId) {
        try {
            const integration = await prisma.integration.findFirst({
                where: { workspaceId, type: 'WHATSAPP', isActive: true }
            });
            const cfg = integration?.config || {};
            return {
                phoneNumberId: cfg.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
                accessToken: cfg.accessToken || process.env.WHATSAPP_ACCESS_TOKEN
            };
        } catch {
            return {
                phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
                accessToken: process.env.WHATSAPP_ACCESS_TOKEN
            };
        }
    }

    /**
     * Format phone number for WhatsApp (must be E.164 without +)
     * e.g. "+91 98765 43210" → "919876543210"
     */
    formatPhone(phone) {
        if (!phone) return null;
        // Remove everything except digits
        const digits = phone.replace(/[^0-9]/g, '');
        // If it starts with 0, assume local — this may need country-code logic
        return digits || null;
    }

    /**
     * Send a WhatsApp text message via Meta Cloud API
     * Falls back to in-app notification if API not configured
     */
    async send(workspaceId, { to, body }) {
        try {
            const config = await this.getConfig(workspaceId);
            const { phoneNumberId, accessToken } = config;
            const formattedPhone = this.formatPhone(to);

            if (!formattedPhone) {
                console.log('⚠️ WhatsApp: Invalid phone number:', to);
                return { success: false, error: 'Invalid phone number' };
            }

            // Try WhatsApp Cloud API if configured
            if (phoneNumberId && accessToken) {
                const response = await fetch(
                    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            messaging_product: 'whatsapp',
                            recipient_type: 'individual',
                            to: formattedPhone,
                            type: 'text',
                            text: { body }
                        })
                    }
                );

                const result = await response.json();

                if (response.ok) {
                    const messageId = result.messages?.[0]?.id;
                    console.log('✅ WhatsApp message sent to:', formattedPhone, '| ID:', messageId);
                    await this.log(workspaceId, 'whatsapp_sent', { to: formattedPhone, messageId });
                    return { success: true, messageId };
                } else {
                    console.log('⚠️ WhatsApp API error:', result.error?.message || JSON.stringify(result));
                    // Fall through to in-app notification
                }
            }

            // Fallback: In-app notification (always works, free)
            console.log('💬 [IN-APP] WhatsApp notification logged for:', to);
            console.log('   Content:', body);

            await prisma.alert.create({
                data: {
                    workspaceId,
                    type: 'SYSTEM',
                    message: `💬 WhatsApp message to ${to}: ${body}`,
                    link: '/inbox'
                }
            });

            await this.log(workspaceId, 'whatsapp_inapp_notification', { to, body });
            return { success: true, method: 'in-app', message: 'Delivered as in-app notification' };
        } catch (error) {
            console.error('WhatsApp send error:', error.message);
            await this.log(workspaceId, 'whatsapp_failed', { to, error: error.message }, 'failed');
            return { success: false, error: error.message };
        }
    }

    /**
     * Send a WhatsApp template message (required for initiating conversations)
     * Templates must be pre-approved in Meta Business Manager
     */
    async sendTemplate(workspaceId, { to, templateName, languageCode = 'en', components = [] }) {
        try {
            const config = await this.getConfig(workspaceId);
            const { phoneNumberId, accessToken } = config;
            const formattedPhone = this.formatPhone(to);

            if (!formattedPhone || !phoneNumberId || !accessToken) {
                return { success: false, error: 'WhatsApp not configured or invalid phone' };
            }

            const response = await fetch(
                `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: formattedPhone,
                        type: 'template',
                        template: {
                            name: templateName,
                            language: { code: languageCode },
                            components
                        }
                    })
                }
            );

            const result = await response.json();

            if (response.ok) {
                const messageId = result.messages?.[0]?.id;
                console.log('✅ WhatsApp template sent:', templateName, 'to:', formattedPhone);
                await this.log(workspaceId, 'whatsapp_template_sent', { to: formattedPhone, templateName, messageId });
                return { success: true, messageId };
            } else {
                console.error('❌ WhatsApp template error:', result.error?.message);
                await this.log(workspaceId, 'whatsapp_template_failed', { to: formattedPhone, templateName, error: result.error?.message }, 'failed');
                return { success: false, error: result.error?.message };
            }
        } catch (error) {
            console.error('WhatsApp template error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async log(workspaceId, event, details, status = 'success') {
        try {
            await prisma.automationLog.create({
                data: {
                    workspaceId,
                    event,
                    action: 'send_whatsapp',
                    status,
                    details: JSON.stringify(details)
                }
            });
        } catch (err) {
            console.error('Failed to log WhatsApp:', err.message);
        }
    }
}

module.exports = new WhatsAppService();
