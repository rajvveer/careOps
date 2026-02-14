const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { ownerOnly, checkPermission } = require('../middleware/roleCheck');

// ─── Form Templates ────────────────────────────────────

// GET /api/forms/templates
router.get('/templates', auth, async (req, res, next) => {
    try {
        const templates = await prisma.formTemplate.findMany({
            where: { workspaceId: req.workspaceId },
            include: {
                linkedServiceType: true,
                _count: { select: { submissions: true } }
            }
        });
        res.json(templates);
    } catch (error) {
        next(error);
    }
});

// POST /api/forms/templates
router.post('/templates', auth, ownerOnly, async (req, res, next) => {
    try {
        const { name, fields, linkedServiceTypeId, googleFormUrl } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        if (!fields && !googleFormUrl) {
            return res.status(400).json({ error: 'Fields or Google Form URL is required' });
        }

        const template = await prisma.formTemplate.create({
            data: {
                workspaceId: req.workspaceId,
                name,
                fields: googleFormUrl ? null : fields,
                googleFormUrl: googleFormUrl || null,
                linkedServiceTypeId: linkedServiceTypeId || null
            }
        });

        // Update onboarding step
        await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { onboardingStep: { set: Math.max(5, req.user.workspace.onboardingStep) } }
        });

        res.status(201).json(template);
    } catch (error) {
        next(error);
    }
});

// PUT /api/forms/templates/:id
router.put('/templates/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        const { name, fields, linkedServiceTypeId, googleFormUrl } = req.body;
        const template = await prisma.formTemplate.update({
            where: { id: req.params.id },
            data: {
                ...(name && { name }),
                ...(fields !== undefined && { fields }),
                ...(googleFormUrl !== undefined && { googleFormUrl: googleFormUrl || null }),
                ...(linkedServiceTypeId !== undefined && { linkedServiceTypeId })
            }
        });
        res.json(template);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/forms/templates/:id
router.delete('/templates/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        // Delete related submissions first to avoid FK constraint violation
        await prisma.formSubmission.deleteMany({
            where: { formTemplateId: req.params.id }
        });
        await prisma.formTemplate.delete({
            where: { id: req.params.id, workspaceId: req.workspaceId }
        });
        res.json({ message: 'Form template deleted' });
    } catch (error) {
        next(error);
    }
});

// ─── Form Submissions ──────────────────────────────────

// GET /api/forms/submissions
router.get('/submissions', auth, checkPermission('forms'), async (req, res, next) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const where = { formTemplate: { workspaceId: req.workspaceId } };
        if (status) where.status = status;

        const [submissions, total] = await Promise.all([
            prisma.formSubmission.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    formTemplate: true,
                    contact: true,
                    booking: { include: { serviceType: true } }
                }
            }),
            prisma.formSubmission.count({ where })
        ]);

        res.json({ submissions, total, page: Number(page), totalPages: Math.ceil(total / limit) });
    } catch (error) {
        next(error);
    }
});

// PATCH /api/forms/submissions/:id
router.patch('/submissions/:id', auth, checkPermission('forms'), async (req, res, next) => {
    try {
        const { status } = req.body;
        const submission = await prisma.formSubmission.update({
            where: { id: req.params.id },
            data: { status }
        });
        res.json(submission);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
