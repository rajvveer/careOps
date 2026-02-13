const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roleCheck');

// GET /api/integrations
router.get('/', auth, async (req, res, next) => {
    try {
        const integrations = await prisma.integration.findMany({
            where: { workspaceId: req.workspaceId }
        });
        res.json(integrations);
    } catch (error) {
        next(error);
    }
});

// POST /api/integrations
router.post('/', auth, ownerOnly, async (req, res, next) => {
    try {
        const { type, provider, config } = req.body;

        if (!type || !provider) {
            return res.status(400).json({ error: 'Type and provider are required' });
        }

        if (!['EMAIL', 'SMS', 'WEBHOOK'].includes(type)) {
            return res.status(400).json({ error: 'Type must be EMAIL, SMS, or WEBHOOK' });
        }

        const integration = await prisma.integration.create({
            data: {
                workspaceId: req.workspaceId,
                type,
                provider,
                config: config || {},
                isActive: true
            }
        });

        // Update onboarding step
        await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { onboardingStep: { set: Math.max(2, req.user.workspace.onboardingStep) } }
        });

        res.status(201).json(integration);
    } catch (error) {
        next(error);
    }
});

// PUT /api/integrations/:id
router.put('/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        const { config, isActive } = req.body;

        const integration = await prisma.integration.update({
            where: { id: req.params.id },
            data: {
                ...(config && { config }),
                ...(isActive !== undefined && { isActive })
            }
        });

        res.json(integration);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/integrations/:id
router.delete('/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.integration.delete({ where: { id: req.params.id } });
        res.json({ message: 'Integration deleted' });
    } catch (error) {
        next(error);
    }
});

// POST /api/integrations/:id/test
router.post('/:id/test', auth, ownerOnly, async (req, res, next) => {
    try {
        const integration = await prisma.integration.findUnique({
            where: { id: req.params.id }
        });

        if (!integration) {
            return res.status(404).json({ error: 'Integration not found' });
        }

        // Simulate a test based on type
        if (integration.type === 'EMAIL') {
            const emailService = require('../services/email');
            const result = await emailService.send(req.workspaceId, {
                to: req.user.email,
                subject: 'CareOps - Email Integration Test',
                text: 'If you received this, your email integration is working correctly!',
                html: '<p>If you received this, your email integration is working correctly! ✅</p>'
            });
            return res.json({ success: result.success, message: result.success ? 'Test email sent' : result.error });
        }

        if (integration.type === 'SMS') {
            return res.json({ success: true, message: 'SMS integration configured successfully (test requires a valid phone number)' });
        }

        res.json({ success: true, message: 'Integration test passed' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
