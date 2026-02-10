const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const auth = require('../middleware/auth');
const { ownerOnly, checkPermission } = require('../middleware/roleCheck');
const automation = require('../services/automation');

// GET /api/inventory
router.get('/', auth, checkPermission('inventory'), async (req, res, next) => {
    try {
        const items = await prisma.inventoryItem.findMany({
            where: { workspaceId: req.workspaceId },
            orderBy: { name: 'asc' }
        });

        // Mark low-stock items
        const enriched = items.map(item => ({
            ...item,
            isLowStock: item.quantity <= item.threshold
        }));

        res.json(enriched);
    } catch (error) {
        next(error);
    }
});

// POST /api/inventory
router.post('/', auth, ownerOnly, async (req, res, next) => {
    try {
        const { name, quantity, threshold, unit } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const item = await prisma.inventoryItem.create({
            data: {
                workspaceId: req.workspaceId,
                name,
                quantity: quantity || 0,
                threshold: threshold || 5,
                unit: unit || 'units'
            }
        });

        // Update onboarding step
        await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { onboardingStep: { set: Math.max(6, req.user.workspace.onboardingStep) } }
        });

        res.status(201).json(item);
    } catch (error) {
        next(error);
    }
});

// PUT /api/inventory/:id
router.put('/:id', auth, checkPermission('inventory'), async (req, res, next) => {
    try {
        const { name, quantity, threshold, unit } = req.body;

        const item = await prisma.inventoryItem.update({
            where: { id: req.params.id },
            data: {
                ...(name && { name }),
                ...(quantity !== undefined && { quantity: Number(quantity) }),
                ...(threshold !== undefined && { threshold: Number(threshold) }),
                ...(unit && { unit })
            }
        });

        // Check if low stock
        if (item.quantity <= item.threshold) {
            await automation.onInventoryLow(req.workspaceId, item);
        }

        res.json({ ...item, isLowStock: item.quantity <= item.threshold });
    } catch (error) {
        next(error);
    }
});

// DELETE /api/inventory/:id
router.delete('/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.inventoryItem.delete({ where: { id: req.params.id } });
        res.json({ message: 'Inventory item deleted' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
