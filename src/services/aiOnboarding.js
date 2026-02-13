const Groq = require('groq-sdk');

class AiOnboardingService {
    constructor() {
        this.groq = null;
    }

    init() {
        if (!this.groq && process.env.GROQ_API_KEY) {
            this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        }
    }

    getStepInfo(step) {
        const steps = {
            1: {
                title: 'Your Workspace',
                description: 'Review your business identity — name, address, timezone, and contact email',
                fields: ['Business Name', 'Address', 'Time Zone', 'Contact Email']
            },
            2: {
                title: 'Communication Channels',
                description: 'Connect email and SMS to enable customer communication',
                fields: ['Email Integration', 'SMS Integration']
            },
            3: {
                title: 'Contact Form',
                description: 'Set up your public contact page where customers can reach you',
                fields: ['Form Fields', 'Public Contact Link']
            },
            4: {
                title: 'Bookings',
                description: 'Create your first bookable service with duration, price, and location',
                fields: ['Service Name', 'Duration', 'Price', 'Location']
            },
            5: {
                title: 'Forms',
                description: 'Set up intake forms that auto-send after bookings',
                fields: ['Form Name', 'Form Fields', 'Linked Service']
            },
            6: {
                title: 'Inventory',
                description: 'Track supplies and materials used in your services',
                fields: ['Item Name', 'Quantity', 'Low-Stock Threshold']
            },
            7: {
                title: 'Team',
                description: 'Invite staff members with customized permissions',
                fields: ['Staff Email', 'Permissions']
            },
            8: {
                title: 'Launch',
                description: 'Final check — then your business goes live!',
                fields: ['Activation']
            }
        };
        return steps[step] || steps[1];
    }

    async generateVoiceScript(step, businessName, businessType, userSelections) {
        this.init();

        const stepInfo = this.getStepInfo(step);

        if (!this.groq) {
            return this.getDefaultScript(step, stepInfo, businessName);
        }

        try {
            // Build context from user selections
            let selectionContext = '';
            if (userSelections) {
                if (userSelections.serviceName) selectionContext += `\nUser chose service: "${userSelections.serviceName}"`;
                if (userSelections.duration) selectionContext += `\nDuration: ${userSelections.duration} minutes`;
                if (userSelections.price !== undefined) selectionContext += `\nPrice: $${userSelections.price}`;
                if (userSelections.location) selectionContext += `\nLocation: ${userSelections.location}`;
                if (userSelections.formName) selectionContext += `\nForm type picked: "${userSelections.formName}"`;
                if (userSelections.inventoryItem) selectionContext += `\nInventory item: "${userSelections.inventoryItem}"`;
                if (userSelections.emailConnected) selectionContext += `\nEmail: Connected ✓`;
                if (userSelections.smsConnected) selectionContext += `\nSMS: Connected ✓`;
                if (userSelections.serviceCreated) selectionContext += `\nService was just created successfully!`;
                if (userSelections.formCreated) selectionContext += `\nForm was just created successfully!`;
                if (userSelections.inviteSent) selectionContext += `\nStaff invitation was just sent!`;
                if (userSelections.action) selectionContext += `\nUser just: ${userSelections.action}`;
            }

            const prompt = `You are Cara, a warm, witty, enthusiastic AI assistant helping a business owner set up their workspace on CareOps.

Generate a short, natural voice script for step ${step} of 8. Talk like a real person — like a fun friend who happens to be a business expert.

Business: ${businessName || 'their business'}
Step: "${stepInfo.title}" — ${stepInfo.description}
${selectionContext ? `\n## What the user has done/selected:\n${selectionContext}` : ''}

Rules:
- Sound like a real, excited person — NOT a corporate robot
- REACT specifically to what the user selected/did (if any selections provided)
- Use contractions (you'll, we're, let's, that's)
- Add personality — use phrases like "nice pick!", "love that!", "ooh great choice", "you're crushing it"
- If they picked something, comment on WHY it's a good choice or give a quick pro tip about it
- Keep sentences short with natural pauses
- Be encouraging and make them feel like they're doing great
- Max 80 words
- NO markdown, emojis, or formatting
- Just pure spoken text that sounds great when read aloud
- Vary your language — never start with "Alright" or "Great" twice in a row`;

            const completion = await this.groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: 'llama-3.3-70b-versatile',
                temperature: 0.9,
                max_tokens: 200,
            });

            const text = completion.choices[0]?.message?.content || '';
            return {
                step,
                title: stepInfo.title,
                script: text,
                fields: stepInfo.fields,
                aiGenerated: true
            };
        } catch (error) {
            console.error('Groq AI error:', error.message);
            return this.getDefaultScript(step, stepInfo, businessName);
        }
    }

    // Quick reaction to a user selection (short, fast)
    async generateReaction(step, selectionType, selectionValue, businessName) {
        this.init();

        if (!this.groq) {
            return this.getDefaultReaction(selectionType, selectionValue);
        }

        try {
            const prompt = `You are Cara, a fun and witty AI assistant. The user just made a selection during onboarding setup.

Business: ${businessName || 'their business'}
Step ${step}: ${this.getStepInfo(step).title}
They just selected: ${selectionType} = "${selectionValue}"

Give a SHORT, fun, enthusiastic 1-2 sentence reaction to their specific choice. Be specific about what they chose — don't be generic!

Examples of good reactions:
- For "Consultation" service: "Ooh, consultation! That's a high-value service. Clients are gonna love the professional booking flow."
- For "30 min" duration: "Thirty minutes is the sweet spot — long enough to be thorough, short enough to pack your schedule!"
- For "$50" price: "Fifty bucks, nice! That's competitive. You can always adjust later as you grow."
- For "Online" location: "Virtual sessions — smart move! No commute for anyone."

Rules:
- Max 25 words
- Sound excited and genuine
- NO markdown or emojis
- Reference the SPECIFIC value they chose
- Be witty, not cheesy`;

            const completion = await this.groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: 'llama-3.3-70b-versatile',
                temperature: 1.0,
                max_tokens: 60,
            });

            return {
                reaction: completion.choices[0]?.message?.content || '',
                aiGenerated: true
            };
        } catch (error) {
            return this.getDefaultReaction(selectionType, selectionValue);
        }
    }

    getDefaultReaction(selectionType, selectionValue) {
        const reactions = {
            serviceName: `Nice pick! "${selectionValue}" is a solid service to start with.`,
            duration: `${selectionValue} minutes — that's a great session length!`,
            price: selectionValue === '0' || selectionValue === 0 ? `Free sessions are perfect for getting started!` : `$${selectionValue} — competitive and fair. Love it!`,
            location: `${selectionValue} — great choice for your clients!`,
            formName: `${selectionValue} — exactly what your clients need before their appointment!`,
            inventoryItem: `${selectionValue} — smart to start tracking that early!`,
        };
        return {
            reaction: reactions[selectionType] || `Great choice!`,
            aiGenerated: false
        };
    }

    async generateChatResponse(message, context) {
        this.init();

        if (!this.groq) {
            return {
                response: "I'm here to help! AI chat requires a Groq API key. Follow the step-by-step guide in the meantime.",
                aiGenerated: false,
                suggestions: this.getSuggestions(context.currentStep, context.page)
            };
        }

        try {
            const prompt = `You are Cara, a friendly, witty AI assistant for CareOps. A business owner needs help.

Context: ${context.page === 'onboarding' ? `Onboarding step ${context.currentStep || 'unknown'} of 8.` : `Dashboard page: ${context.page || 'main'}`}
Business: ${context.businessName || 'Not yet named'}

Question: "${message}"

Rules:
- Respond concisely (under 60 words)
- Sound like a real person — fun, warm, knowledgeable
- Use contractions
- Be specific and helpful
- No markdown formatting
- If they ask about the current step, give actionable advice`;

            const completion = await this.groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: 'llama-3.3-70b-versatile',
                temperature: 0.8,
                max_tokens: 150,
            });

            return {
                response: completion.choices[0]?.message?.content || '',
                aiGenerated: true,
                suggestions: this.getSuggestions(context.currentStep, context.page)
            };
        } catch (error) {
            console.error('Groq chat error:', error.message);
            return {
                response: "Having trouble right now. Try again in a moment, or continue with the guide.",
                aiGenerated: false,
                suggestions: this.getSuggestions(context.currentStep, context.page)
            };
        }
    }

    getSuggestions(step, page) {
        if (page === 'dashboard') {
            return [
                "How's my business doing?",
                "Any urgent tasks?",
                "Show booking stats",
                "Low stock items?",
                "Unanswered messages?"
            ];
        }

        const onboardingSuggestions = {
            1: ["What should my timezone be?", "Can I change this later?", "What's a workspace?"],
            2: ["Why do I need email?", "Is SMS required?", "How do notifications work?"],
            3: ["How do clients find my form?", "Can I add custom fields?", "Where do I share this?"],
            4: ["What service should I create?", "How long should sessions be?", "Can I add more later?"],
            5: ["What's an intake form?", "Do forms auto-send?", "What fields should I add?"],
            6: ["What should I track?", "How do alerts work?", "Can I skip this step?"],
            7: ["What can staff access?", "Can I add more later?", "How do teams work?"],
            8: ["What happens at launch?", "Am I ready?", "Can I undo this?"],
        };
        return onboardingSuggestions[step] || ["Help me with this step", "What should I do?", "Can I skip this?"];
    }

    getDefaultScript(step, stepInfo, businessName) {
        const name = businessName || 'your business';
        const scripts = {
            1: `Hey! Welcome to CareOps. I'm Cara, and I'll walk you through the setup. So first up, let's check out your workspace. This is your home base, everything lives here. You'll see your business name, address, timezone, and contact email. If anything looks off, just update it later in Settings. Ready? Let's go!`,
            2: `Now we're setting up how you talk to clients. You've got email and SMS. Email's great for booking confirmations and follow-ups. SMS is perfect for quick reminders. I'd say connect at least email to start. Just tap Connect and you're good!`,
            3: `Let's set up your public contact page! This is where new clients can reach you directly. The default form collects name, email, phone, and a message. You can customize the fields if you like. Once you're happy with it, copy the link and share it on your website or social media!`,
            4: `Let's create your first service! I've got some suggestions for you. Just pick the one that fits, or type your own. Then choose how long it takes, the price, and where it happens. Once you save, clients get a beautiful booking page automatically. Don't overthink it, you can add more later!`,
            5: `Now let's set up forms. Pick a form type, like an intake form or consent form. We'll add basic fields automatically. These forms auto-send to clients after they book, so everything's ready before their appointment. You can always add more fields later from the Forms page.`,
            6: `Time for inventory tracking! If you use supplies in your services, just pick from the common items I'm suggesting, or add your own. Set a quantity and alert threshold, and we'll let you know before you run out. Don't need this? Feel free to skip!`,
            7: `Got a team? Pop in their email and we'll send them a join link. You control what they can access. No team yet? Totally fine, skip this and come back later!`,
            8: `You made it! Everything's ready to go. Hit that Launch button and your booking links go live, contact forms start working, and all automations kick in. You've done amazing. Let's launch ${name}!`
        };

        return {
            step,
            title: stepInfo.title,
            script: scripts[step] || scripts[1],
            fields: stepInfo.fields,
            aiGenerated: false
        };
    }
}

module.exports = new AiOnboardingService();
