const prisma = require('../lib/prisma');

class WebhookService {
    /**
     * Fire webhook events to all active webhook integrations for a workspace
     * @param {string} workspaceId
     * @param {string} event - e.g. 'contact.created', 'booking.created', 'inventory.low'
     * @param {object} payload - event data
     */
    async fire(workspaceId, event, payload) {
        try {
            const webhooks = await prisma.integration.findMany({
                where: { workspaceId, type: 'WEBHOOK', isActive: true }
            });

            if (webhooks.length === 0) return;

            const results = await Promise.allSettled(
                webhooks.map(wh => this.send(wh, event, payload, workspaceId))
            );

            results.forEach((result, i) => {
                if (result.status === 'rejected') {
                    console.error(`⚠️ Webhook ${webhooks[i].id} failed:`, result.reason?.message);
                }
            });
        } catch (error) {
            console.error('Webhook fire error:', error.message);
        }
    }

    async send(webhook, event, payload, workspaceId) {
        const url = webhook.config?.url;
        if (!url) {
            console.warn(`⚠️ Webhook ${webhook.id} has no URL configured`);
            return;
        }

        const body = JSON.stringify({
            event,
            timestamp: new Date().toISOString(),
            workspaceId,
            data: payload
        });

        const headers = {
            'Content-Type': 'application/json',
            'X-CareOps-Event': event,
            ...(webhook.config?.secret && {
                'X-CareOps-Signature': this.sign(body, webhook.config.secret)
            })
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal
            });

            await prisma.automationLog.create({
                data: {
                    workspaceId,
                    event: `webhook.${event}`,
                    status: response.ok ? 'success' : 'failed',
                    details: `Webhook ${webhook.id} → ${url} (${response.status})`
                }
            });

            if (!response.ok) {
                console.warn(`⚠️ Webhook responded ${response.status}: ${url}`);
            }
        } catch (error) {
            await prisma.automationLog.create({
                data: {
                    workspaceId,
                    event: `webhook.${event}`,
                    status: 'failed',
                    details: `Webhook ${webhook.id} → ${url}: ${error.message}`
                }
            });
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Simple HMAC signing for webhook verification
     */
    sign(payload, secret) {
        const crypto = require('crypto');
        return crypto.createHmac('sha256', secret).update(payload).digest('hex');
    }
}

module.exports = new WebhookService();
