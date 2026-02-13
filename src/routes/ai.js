const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const aiOnboarding = require('../services/aiOnboarding');

// POST /api/ai/onboarding-guide - Get AI voice script for onboarding step
router.post('/onboarding-guide', auth, async (req, res, next) => {
    try {
        const { step, userSelections } = req.body;
        const workspace = req.user.workspace;

        if (!step || step < 1 || step > 8) {
            return res.status(400).json({ error: 'Step must be between 1 and 8' });
        }

        const guide = await aiOnboarding.generateVoiceScript(
            step,
            workspace?.name,
            req.body.businessType,
            userSelections
        );

        // Include suggestions for this step
        guide.suggestions = aiOnboarding.getSuggestions(step, 'onboarding');

        res.json(guide);
    } catch (error) {
        next(error);
    }
});

// POST /api/ai/reaction - Quick AI reaction to user selection
router.post('/reaction', auth, async (req, res, next) => {
    try {
        const { step, selectionType, selectionValue } = req.body;
        if (!selectionType || !selectionValue) {
            return res.status(400).json({ error: 'selectionType and selectionValue required' });
        }

        const result = await aiOnboarding.generateReaction(
            step || 1,
            selectionType,
            selectionValue,
            req.user.workspace?.name
        );

        res.json(result);
    } catch (error) {
        next(error);
    }
});

// POST /api/ai/chat - Conversational AI assistant
router.post('/chat', auth, async (req, res, next) => {
    try {
        const { message, page } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const response = await aiOnboarding.generateChatResponse(message, {
            currentStep: req.user.workspace?.onboardingStep,
            businessName: req.user.workspace?.name,
            page: page || 'dashboard'
        });

        res.json(response);
    } catch (error) {
        next(error);
    }
});

// GET /api/ai/onboarding-steps - Get all step metadata
router.get('/onboarding-steps', auth, async (req, res) => {
    const steps = [];
    for (let i = 1; i <= 8; i++) {
        steps.push({
            step: i,
            ...aiOnboarding.getStepInfo(i),
            completed: i < (req.user.workspace?.onboardingStep || 1),
            current: i === (req.user.workspace?.onboardingStep || 1)
        });
    }
    res.json(steps);
});

// POST /api/ai/inventory-suggestions - AI-generated inventory suggestions
router.post('/inventory-suggestions', auth, async (req, res, next) => {
    try {
        const workspace = req.user.workspace;
        const businessName = workspace?.name || 'business';

        // Get the first service type for context
        const prisma = require('../lib/prisma');
        const serviceTypes = await prisma.serviceType.findMany({
            where: { workspaceId: req.workspaceId },
            take: 3,
            select: { name: true }
        });
        const serviceNames = serviceTypes.map(s => s.name).join(', ') || 'general services';

        const Groq = require('groq-sdk');
        const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

        if (!groq) {
            return res.json({
                items: ['Exam Gloves', 'Face Masks', 'Bandages', 'Sanitizer', 'Paper Towels', 'Gauze Pads', 'Tissue Paper', 'Cleaning Spray'],
                aiGenerated: false
            });
        }

        const completion = await groq.chat.completions.create({
            messages: [{
                role: 'user',
                content: `You are helping a business owner set up inventory tracking.

Business name: "${businessName}"
Services offered: ${serviceNames}

Generate exactly 10 inventory/supply items that this SPECIFIC type of business would need to track. The items MUST be directly related to the services offered, NOT generic office supplies.

Rules:
- Return ONLY a JSON array of strings, nothing else
- Each item should be 1-3 words
- Be specific to the business type (e.g., clinic → "Exam Gloves", salon → "Hair Color", gym → "Yoga Mats")
- Most commonly used items first

Example output: ["Item 1", "Item 2", "Item 3"]`
            }],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.5,
            max_tokens: 200,
        });

        let items;
        try {
            const raw = completion.choices[0]?.message?.content || '[]';
            items = JSON.parse(raw.trim());
            if (!Array.isArray(items)) throw new Error('Not an array');
        } catch {
            items = ['Exam Gloves', 'Face Masks', 'Bandages', 'Sanitizer', 'Paper Towels', 'Gauze Pads', 'Tissue Paper', 'Cleaning Spray'];
        }

        res.json({ items, aiGenerated: true });
    } catch (error) {
        console.error('AI inventory suggestions error:', error.message);
        res.json({
            items: ['Exam Gloves', 'Face Masks', 'Bandages', 'Sanitizer', 'Paper Towels', 'Gauze Pads', 'Tissue Paper', 'Cleaning Spray'],
            aiGenerated: false
        });
    }
});

// POST /api/ai/dashboard-chat - Dashboard AI assistant with full workspace context
router.post('/dashboard-chat', auth, async (req, res, next) => {
    try {
        const { message, history = [] } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        const prisma = require('../lib/prisma');
        const Groq = require('groq-sdk');
        const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

        if (!groq) {
            return res.json({
                response: "AI assistant requires a Groq API key to be configured. Please add GROQ_API_KEY to your environment.",
                aiGenerated: false
            });
        }

        const workspaceId = req.workspaceId;
        const now = new Date();
        const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Fetch workspace context in parallel
        const [
            workspace, todayBookings, upcomingBookings,
            openConversations, allConversations,
            pendingForms, overdueForms,
            allInventory, unreadAlerts, recentAlerts,
            totalContacts, staffCount
        ] = await Promise.all([
            prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, contactEmail: true, isActive: true } }),
            prisma.booking.count({ where: { workspaceId, dateTime: { gte: todayStart, lte: todayEnd } } }),
            prisma.booking.count({ where: { workspaceId, dateTime: { gt: todayEnd, lte: weekFromNow }, status: 'CONFIRMED' } }),
            prisma.conversation.count({ where: { workspaceId, status: 'open' } }),
            prisma.conversation.findMany({
                where: { workspaceId, status: 'open' },
                include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
            }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'PENDING' } }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'OVERDUE' } }),
            prisma.inventoryItem.findMany({ where: { workspaceId }, select: { name: true, quantity: true, threshold: true, unit: true } }),
            prisma.alert.count({ where: { workspaceId, isRead: false } }),
            prisma.alert.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 5, select: { message: true, type: true, createdAt: true, isRead: true } }),
            prisma.contact.count({ where: { workspaceId } }),
            prisma.user.count({ where: { workspaceId, role: 'STAFF' } })
        ]);

        const unansweredMessages = allConversations.filter(c =>
            c.messages.length > 0 && c.messages[0].direction === 'INBOUND'
        ).length;
        const lowStockItems = allInventory.filter(item => item.quantity <= item.threshold);

        // Build system prompt with all context
        const systemPrompt = `You are Cara, an intelligent AI assistant for CareOps — a business operations platform. You have full access to the user's workspace data.

## Current Workspace Snapshot (real-time)
- **Business**: ${workspace?.name || 'Unknown'}
- **Contact Email**: ${workspace?.contactEmail || 'Not set'}
- **Status**: ${workspace?.isActive ? 'Active (Live)' : 'Setup in progress'}

## User Info
- **Name**: ${req.user.name}
- **Role**: ${req.user.role}

## Today's Numbers (${now.toLocaleDateString()})
- Bookings today: ${todayBookings}
- Upcoming bookings (next 7 days): ${upcomingBookings}
- Open conversations: ${openConversations}
- Unanswered messages: ${unansweredMessages}
- Pending forms: ${pendingForms}
- Overdue forms: ${overdueForms}
- Unread alerts: ${unreadAlerts}
- Total contacts: ${totalContacts}
- Staff members: ${staffCount}

## Inventory Status
${lowStockItems.length > 0 ? lowStockItems.map(i => `- ⚠️ LOW: ${i.name} — ${i.quantity} ${i.unit} (threshold: ${i.threshold})`).join('\n') : '- All items are well-stocked ✅'}
${allInventory.length === 0 ? '- No inventory items tracked yet' : `- Total items tracked: ${allInventory.length}`}

## Recent Alerts
${recentAlerts.length > 0 ? recentAlerts.map(a => `- ${a.isRead ? '✓' : '🔴'} ${a.message} (${new Date(a.createdAt).toLocaleString()})`).join('\n') : '- No recent alerts'}

## Rules
- Be helpful, concise, and specific. Use real numbers from the data above.
- When asked about business status, give a quick summary with actual figures.
- If something needs attention (unanswered messages, low stock, overdue forms), proactively mention it.
- Keep responses under 100 words unless the user asks for detail.
- Sound like a friendly colleague, not a robot. Use contractions.
- Do NOT make up data. Only use what's provided above.
- If asked something outside your data, say so.`;

        // Build messages array with history
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.slice(-10).map((m) => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content
            })),
            { role: 'user', content: message }
        ];

        const completion = await groq.chat.completions.create({
            messages,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7,
            max_tokens: 300,
        });

        const response = completion.choices[0]?.message?.content || "Sorry, I couldn't process that. Try again?";

        res.json({ response, aiGenerated: true });
    } catch (error) {
        console.error('Dashboard chat error:', error.message);
        res.json({
            response: "Having trouble right now. Please try again in a moment.",
            aiGenerated: false
        });
    }
});

// POST /api/ai/draft-reply - AI auto-draft reply for inbox
router.post('/draft-reply', auth, async (req, res, next) => {
    try {
        const { conversationId } = req.body;
        if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

        const prisma = require('../lib/prisma');
        const Groq = require('groq-sdk');
        const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

        if (!groq) {
            return res.json({ draft: "Thank you for reaching out! We've received your message and will get back to you shortly.", aiGenerated: false });
        }

        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, workspaceId: req.workspaceId },
            include: {
                contact: true,
                messages: { orderBy: { createdAt: 'asc' }, take: 10 }
            }
        });

        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const workspace = req.user.workspace;
        const msgHistory = conversation.messages.map(m =>
            `${m.direction === 'INBOUND' ? conversation.contact.name : 'Staff'}: ${m.content}`
        ).join('\n');

        const prompt = `You are Cara, drafting a reply on behalf of "${workspace?.name || 'the business'}" to a client named "${conversation.contact.name}".

Conversation so far:
${msgHistory}

Draft a professional, warm, helpful reply. Rules:
- Be specific to what they asked/said
- Keep it under 3 sentences
- Sound human and caring, not robotic
- Don't use "Dear" or overly formal language
- Include relevant next steps if appropriate
- Just the reply text, nothing else`;

        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7,
            max_tokens: 200,
        });

        res.json({
            draft: completion.choices[0]?.message?.content || "Thank you for your message! We'll be happy to help.",
            aiGenerated: true
        });
    } catch (error) {
        console.error('AI draft-reply error:', error.message);
        res.json({ draft: "Thank you for reaching out! We'll get back to you shortly.", aiGenerated: false });
    }
});

module.exports = router;

