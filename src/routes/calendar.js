const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roleCheck');
const calendarService = require('../services/calendar');

// GET /api/calendar/connect - Get Google OAuth URL
router.get('/connect', auth, ownerOnly, async (req, res, next) => {
    try {
        const authUrl = calendarService.getAuthUrl();
        // Store workspaceId in state param for callback
        const stateUrl = `${authUrl}&state=${req.workspaceId}`;
        res.json({ authUrl: stateUrl });
    } catch (error) {
        next(error);
    }
});

// GET /api/calendar/callback - OAuth callback (redirected by Google)
router.get('/callback', async (req, res, next) => {
    try {
        const { code, state: workspaceId } = req.query;

        if (!code) {
            return res.status(400).json({ error: 'Authorization code missing' });
        }

        const oauth2Client = calendarService.getOAuth2Client();
        const { tokens } = await oauth2Client.getToken(code);

        await calendarService.saveConnection(workspaceId, tokens);

        // Redirect back to frontend
        res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?connected=true`);
    } catch (error) {
        console.error('Calendar callback error:', error);
        res.redirect(`${process.env.FRONTEND_URL}/settings/calendar?error=true`);
    }
});

// GET /api/calendar/status - Check calendar connection
router.get('/status', auth, async (req, res, next) => {
    try {
        const connection = await prisma.calendarConnection.findFirst({
            where: { workspaceId: req.workspaceId }
        });

        res.json({
            connected: !!connection,
            provider: connection?.provider || null,
            calendarId: connection?.calendarId || null,
            connectedAt: connection?.createdAt || null
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/calendar/events - List upcoming events
router.get('/events', auth, async (req, res, next) => {
    try {
        const { timeMin, timeMax } = req.query;
        const events = await calendarService.listEvents(
            req.workspaceId,
            timeMin,
            timeMax
        );
        res.json(events);
    } catch (error) {
        next(error);
    }
});

// POST /api/calendar/sync-booking/:bookingId - Sync a booking to calendar
router.post('/sync-booking/:bookingId', auth, async (req, res, next) => {
    try {
        const booking = await prisma.booking.findFirst({
            where: { id: req.params.bookingId, workspaceId: req.workspaceId },
            include: { contact: true, serviceType: true }
        });

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        const result = await calendarService.createEvent(req.workspaceId, booking);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/calendar/disconnect - Disconnect calendar
router.delete('/disconnect', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.calendarConnection.deleteMany({
            where: { workspaceId: req.workspaceId }
        });
        res.json({ message: 'Calendar disconnected' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
