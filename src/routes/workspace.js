const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roleCheck');

// GET /api/workspace
router.get('/', auth, async (req, res, next) => {
    try {
        const workspace = await prisma.workspace.findUnique({
            where: { id: req.workspaceId },
            include: {
                integrations: true,
                _count: {
                    select: {
                        serviceTypes: true,
                        contacts: true,
                        bookings: true,
                        users: true
                    }
                }
            }
        });

        if (!workspace) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        res.json(workspace);
    } catch (error) {
        next(error);
    }
});

// PUT /api/workspace
router.put('/', auth, ownerOnly, async (req, res, next) => {
    try {
        const { name, address, timezone, contactEmail } = req.body;

        const workspace = await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: {
                ...(name && { name }),
                ...(address !== undefined && { address }),
                ...(timezone && { timezone }),
                ...(contactEmail && { contactEmail }),
                onboardingStep: { set: Math.max(1, req.user.workspace.onboardingStep) }
            }
        });

        res.json(workspace);
    } catch (error) {
        next(error);
    }
});

// POST /api/workspace/activate
router.post('/activate', auth, ownerOnly, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;

        // Validate readiness
        const integrations = await prisma.integration.findMany({
            where: { workspaceId, isActive: true }
        });
        if (integrations.length === 0) {
            return res.status(400).json({ error: 'At least one communication channel (Email or SMS) must be configured' });
        }

        const serviceTypes = await prisma.serviceType.findMany({
            where: { workspaceId }
        });
        if (serviceTypes.length === 0) {
            return res.status(400).json({ error: 'At least one service/booking type must be created' });
        }

        const availability = await prisma.availability.findMany({
            where: { serviceType: { workspaceId } }
        });
        if (availability.length === 0) {
            return res.status(400).json({ error: 'Availability must be defined for at least one service type' });
        }

        const workspace = await prisma.workspace.update({
            where: { id: workspaceId },
            data: { isActive: true, onboardingStep: 8 }
        });

        res.json({ message: 'Workspace activated successfully!', workspace });
    } catch (error) {
        next(error);
    }
});

// PUT /api/workspace/onboarding-step
router.put('/onboarding-step', auth, ownerOnly, async (req, res, next) => {
    try {
        const { step } = req.body;
        const workspace = await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { onboardingStep: step }
        });
        res.json(workspace);
    } catch (error) {
        next(error);
    }
});

// GET /api/workspace/contact-form - Get contact form config
router.get('/contact-form', auth, async (req, res, next) => {
    try {
        const workspace = await prisma.workspace.findUnique({
            where: { id: req.workspaceId },
            select: { contactFormFields: true }
        });
        const defaultFields = [
            { name: 'Name', type: 'text', required: true },
            { name: 'Email', type: 'email', required: true },
            { name: 'Phone', type: 'tel', required: false },
            { name: 'Message', type: 'textarea', required: true }
        ];
        res.json({ fields: workspace?.contactFormFields || defaultFields });
    } catch (error) {
        next(error);
    }
});

// PUT /api/workspace/contact-form - Update contact form config (owner only)
router.put('/contact-form', auth, ownerOnly, async (req, res, next) => {
    try {
        const { fields } = req.body;
        if (!Array.isArray(fields) || fields.length === 0) {
            return res.status(400).json({ error: 'Fields must be a non-empty array' });
        }
        const workspace = await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { contactFormFields: fields }
        });
        res.json({ message: 'Contact form updated', fields: workspace.contactFormFields });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
