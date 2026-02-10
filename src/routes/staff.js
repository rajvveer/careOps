const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roleCheck');
const emailService = require('../services/email');

// GET /api/staff - List staff members
router.get('/', auth, ownerOnly, async (req, res, next) => {
    try {
        const staff = await prisma.user.findMany({
            where: { workspaceId: req.workspaceId, role: 'STAFF' },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                createdAt: true,
                permissions: true
            }
        });
        res.json(staff);
    } catch (error) {
        next(error);
    }
});

// GET /api/staff/invitations - List pending invitations
router.get('/invitations', auth, ownerOnly, async (req, res, next) => {
    try {
        const invitations = await prisma.staffInvitation.findMany({
            where: { workspaceId: req.workspaceId },
            orderBy: { createdAt: 'desc' }
        });
        res.json(invitations);
    } catch (error) {
        next(error);
    }
});

// POST /api/staff/invite - Generate invitation link
router.post('/invite', auth, ownerOnly, async (req, res, next) => {
    try {
        const { email, permissions } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Check if user already exists
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(409).json({ error: 'This email is already registered' });
        }

        // Check if invitation already exists
        const existingInvite = await prisma.staffInvitation.findFirst({
            where: { email, workspaceId: req.workspaceId, usedAt: null }
        });
        if (existingInvite) {
            return res.status(409).json({ error: 'An invitation is already pending for this email' });
        }

        // Generate unique token
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const invitation = await prisma.staffInvitation.create({
            data: {
                workspaceId: req.workspaceId,
                email,
                token,
                permissions: {
                    inbox: permissions?.inbox ?? true,
                    bookings: permissions?.bookings ?? true,
                    forms: permissions?.forms ?? true,
                    inventory: permissions?.inventory ?? false
                },
                expiresAt
            }
        });

        // Generate invitation link
        const inviteLink = `${process.env.FRONTEND_URL}/invite/${token}`;

        // Send invitation email
        const workspace = await prisma.workspace.findUnique({ where: { id: req.workspaceId } });
        await emailService.send(req.workspaceId, {
            to: email,
            subject: `You're invited to join ${workspace.name} on CareOps`,
            text: `You've been invited to join ${workspace.name} as a staff member. Click here to accept: ${inviteLink}`,
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6366f1;">You're Invited! 🎉</h2>
          <p>You've been invited to join <strong>${workspace.name}</strong> as a staff member on CareOps.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${inviteLink}" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
              Accept Invitation
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">This invitation expires in 7 days.</p>
          <p style="color: #666; font-size: 12px;">Invitation link: ${inviteLink}</p>
        </div>
      `
        });

        // Update onboarding step
        await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { onboardingStep: { set: Math.max(7, req.user.workspace.onboardingStep) } }
        });

        res.status(201).json({
            message: 'Invitation sent successfully!',
            invitation: {
                id: invitation.id,
                email: invitation.email,
                inviteLink,
                expiresAt: invitation.expiresAt
            }
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/staff/invite/:token - Validate invitation (PUBLIC - no auth)
router.get('/invite/:token', async (req, res, next) => {
    try {
        const invitation = await prisma.staffInvitation.findUnique({
            where: { token: req.params.token },
            include: { workspace: { select: { name: true, address: true } } }
        });

        if (!invitation) {
            return res.status(404).json({ error: 'Invitation not found' });
        }

        if (invitation.usedAt) {
            return res.status(410).json({ error: 'This invitation has already been used' });
        }

        if (new Date() > invitation.expiresAt) {
            return res.status(410).json({ error: 'This invitation has expired' });
        }

        res.json({
            valid: true,
            email: invitation.email,
            workspace: invitation.workspace,
            expiresAt: invitation.expiresAt
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/staff/register/:token - Staff registers via invitation (PUBLIC - no auth)
router.post('/register/:token', async (req, res, next) => {
    try {
        const { name, password } = req.body;

        if (!name || !password) {
            return res.status(400).json({ error: 'Name and password are required' });
        }

        const invitation = await prisma.staffInvitation.findUnique({
            where: { token: req.params.token }
        });

        if (!invitation) {
            return res.status(404).json({ error: 'Invitation not found' });
        }

        if (invitation.usedAt) {
            return res.status(410).json({ error: 'This invitation has already been used' });
        }

        if (new Date() > invitation.expiresAt) {
            return res.status(410).json({ error: 'This invitation has expired' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const perms = invitation.permissions;

        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: {
                    email: invitation.email,
                    password: hashedPassword,
                    name,
                    role: 'STAFF',
                    workspaceId: invitation.workspaceId
                }
            });

            await tx.staffPermission.create({
                data: {
                    userId: user.id,
                    inbox: perms.inbox ?? true,
                    bookings: perms.bookings ?? true,
                    forms: perms.forms ?? true,
                    inventory: perms.inventory ?? false
                }
            });

            // Mark invitation as used
            await tx.staffInvitation.update({
                where: { id: invitation.id },
                data: { usedAt: new Date() }
            });

            return user;
        });

        const token = jwt.sign({ userId: result.id }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '7d'
        });

        res.status(201).json({
            message: 'Account created successfully!',
            token,
            user: {
                id: result.id,
                email: result.email,
                name: result.name,
                role: result.role,
                workspaceId: result.workspaceId
            }
        });
    } catch (error) {
        next(error);
    }
});

// PUT /api/staff/:id/permissions
router.put('/:id/permissions', auth, ownerOnly, async (req, res, next) => {
    try {
        const { inbox, bookings, forms, inventory } = req.body;

        const permission = await prisma.staffPermission.upsert({
            where: { userId: req.params.id },
            update: {
                ...(inbox !== undefined && { inbox }),
                ...(bookings !== undefined && { bookings }),
                ...(forms !== undefined && { forms }),
                ...(inventory !== undefined && { inventory })
            },
            create: {
                userId: req.params.id,
                inbox: inbox ?? true,
                bookings: bookings ?? true,
                forms: forms ?? true,
                inventory: inventory ?? false
            }
        });

        res.json(permission);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/staff/:id
router.delete('/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.staffPermission.deleteMany({ where: { userId: req.params.id } });
        await prisma.user.delete({ where: { id: req.params.id } });
        res.json({ message: 'Staff member removed' });
    } catch (error) {
        next(error);
    }
});

// DELETE /api/staff/invitations/:id - Revoke invitation
router.delete('/invitations/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.staffInvitation.delete({ where: { id: req.params.id } });
        res.json({ message: 'Invitation revoked' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
