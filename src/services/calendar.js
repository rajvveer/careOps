const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

class CalendarService {
    getOAuth2Client() {
        return new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
    }

    getAuthUrl() {
        const oauth2Client = this.getOAuth2Client();
        return oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/calendar.events'
            ],
            prompt: 'consent'
        });
    }

    async handleCallback(code, workspaceId) {
        const oauth2Client = this.getOAuth2Client();
        const { tokens } = await oauth2Client.getToken(code);

        // Save tokens to database
        const connection = await prisma.calendarConnection.upsert({
            where: { id: workspaceId }, // We'll use findFirst instead
            create: {
                workspaceId,
                provider: 'google',
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                calendarId: 'primary',
                expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
            },
            update: {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token || undefined,
                expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
            }
        });

        return connection;
    }

    async saveConnection(workspaceId, tokens) {
        // Delete existing connections for this workspace
        await prisma.calendarConnection.deleteMany({ where: { workspaceId } });

        return prisma.calendarConnection.create({
            data: {
                workspaceId,
                provider: 'google',
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                calendarId: 'primary',
                expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
            }
        });
    }

    async getAuthenticatedClient(workspaceId) {
        const connection = await prisma.calendarConnection.findFirst({
            where: { workspaceId }
        });

        if (!connection) return null;

        const oauth2Client = this.getOAuth2Client();
        oauth2Client.setCredentials({
            access_token: connection.accessToken,
            refresh_token: connection.refreshToken
        });

        // Handle token refresh
        oauth2Client.on('tokens', async (tokens) => {
            await prisma.calendarConnection.update({
                where: { id: connection.id },
                data: {
                    accessToken: tokens.access_token,
                    ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
                    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
                }
            });
        });

        return { oauth2Client, calendarId: connection.calendarId || 'primary' };
    }

    async createEvent(workspaceId, booking) {
        try {
            const client = await this.getAuthenticatedClient(workspaceId);
            if (!client) {
                console.log('📅 Google Calendar not connected for workspace:', workspaceId);
                return { success: false, error: 'Calendar not connected' };
            }

            const calendar = google.calendar({ version: 'v3', auth: client.oauth2Client });

            const event = {
                summary: `${booking.serviceType?.name || 'Appointment'} - ${booking.contact?.name || 'Customer'}`,
                description: `Booking via CareOps\nContact: ${booking.contact?.name}\nEmail: ${booking.contact?.email || 'N/A'}\nPhone: ${booking.contact?.phone || 'N/A'}\n${booking.notes ? 'Notes: ' + booking.notes : ''}`,
                start: {
                    dateTime: new Date(booking.dateTime).toISOString(),
                    timeZone: 'UTC'
                },
                end: {
                    dateTime: new Date(booking.endTime).toISOString(),
                    timeZone: 'UTC'
                },
                location: booking.serviceType?.location || undefined,
                reminders: {
                    useDefault: false,
                    overrides: [
                        { method: 'popup', minutes: 30 },
                        { method: 'email', minutes: 60 }
                    ]
                }
            };

            const result = await calendar.events.insert({
                calendarId: client.calendarId,
                resource: event
            });

            console.log('✅ Calendar event created:', result.data.id);
            return { success: true, eventId: result.data.id, htmlLink: result.data.htmlLink };
        } catch (error) {
            console.error('Calendar event creation error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async deleteEvent(workspaceId, eventId) {
        try {
            const client = await this.getAuthenticatedClient(workspaceId);
            if (!client) return { success: false };

            const calendar = google.calendar({ version: 'v3', auth: client.oauth2Client });
            await calendar.events.delete({
                calendarId: client.calendarId,
                eventId
            });

            return { success: true };
        } catch (error) {
            console.error('Calendar event deletion error:', error.message);
            return { success: false, error: error.message };
        }
    }

    async listEvents(workspaceId, timeMin, timeMax) {
        try {
            const client = await this.getAuthenticatedClient(workspaceId);
            if (!client) return [];

            const calendar = google.calendar({ version: 'v3', auth: client.oauth2Client });
            const result = await calendar.events.list({
                calendarId: client.calendarId,
                timeMin: timeMin || new Date().toISOString(),
                timeMax: timeMax || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                singleEvents: true,
                orderBy: 'startTime'
            });

            return result.data.items || [];
        } catch (error) {
            console.error('Calendar list error:', error.message);
            return [];
        }
    }
}

module.exports = new CalendarService();
