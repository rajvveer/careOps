const { GoogleGenerativeAI } = require('@google/generative-ai');

class AiOnboardingService {
    constructor() {
        this.genAI = null;
        this.model = null;
    }

    init() {
        if (!this.genAI && process.env.GEMINI_API_KEY) {
            this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        }
    }

    getStepInfo(step) {
        const steps = {
            1: {
                title: 'Create Your Workspace',
                description: 'Set up your business identity — name, address, timezone, and contact email',
                fields: ['Business Name', 'Address', 'Time Zone', 'Contact Email']
            },
            2: {
                title: 'Set Up Communication Channels',
                description: 'Connect email and SMS services to enable customer communication',
                fields: ['Email Integration (Brevo)', 'SMS Integration']
            },
            3: {
                title: 'Create Contact Form',
                description: 'Build a public contact form for customer inquiries',
                fields: ['Form Fields (Name, Email/Phone, Message)']
            },
            4: {
                title: 'Set Up Bookings',
                description: 'Define your services, durations, and availability',
                fields: ['Service Name', 'Duration', 'Location', 'Availability (Days & Time Slots)']
            },
            5: {
                title: 'Set Up Forms',
                description: 'Create intake forms and agreements to send after bookings',
                fields: ['Form Name', 'Form Fields', 'Link to Service Type']
            },
            6: {
                title: 'Set Up Inventory',
                description: 'Track resources and items used per booking',
                fields: ['Item Name', 'Quantity', 'Low-Stock Threshold', 'Unit']
            },
            7: {
                title: 'Invite Your Team',
                description: 'Send personal invitation links to staff members',
                fields: ['Staff Email', 'Permissions (Inbox, Bookings, Forms, Inventory)']
            },
            8: {
                title: 'Activate Workspace',
                description: 'Final verification — then your business goes live!',
                fields: ['Verify Communication Channel', 'Verify Booking Types', 'Verify Availability']
            }
        };
        return steps[step] || steps[1];
    }

    async generateVoiceScript(step, businessName, businessType) {
        this.init();

        const stepInfo = this.getStepInfo(step);

        // If Gemini is not configured, return a pre-written script
        if (!this.model) {
            return this.getDefaultScript(step, stepInfo, businessName);
        }

        try {
            const prompt = `You are a friendly, professional AI onboarding assistant for CareOps, a business operations platform.

Generate a warm, conversational voice script (2-3 paragraphs, spoken naturally) to guide a business owner through step ${step} of 8 in their setup.

Business name: ${businessName || 'their business'}
Business type: ${businessType || 'service business'}

Current step: "${stepInfo.title}"
What this step does: ${stepInfo.description}
Fields to fill: ${stepInfo.fields.join(', ')}

Requirements:
- Sound warm and encouraging, like a helpful assistant
- Explain WHY this step matters for their business
- Give brief, clear instructions on what to fill in
- End with encouragement to continue
- Keep it under 150 words
- Do NOT use markdown, emojis, or formatting — pure spoken text
- Use natural pauses with commas and periods`;

            const result = await this.model.generateContent(prompt);
            const text = result.response.text();
            return {
                step,
                title: stepInfo.title,
                script: text,
                fields: stepInfo.fields,
                aiGenerated: true
            };
        } catch (error) {
            console.error('Gemini AI error:', error.message);
            return this.getDefaultScript(step, stepInfo, businessName);
        }
    }

    async generateChatResponse(message, context) {
        this.init();

        if (!this.model) {
            return {
                response: "I'm here to help you set up your business on CareOps! Currently, AI chat requires a Gemini API key to be configured. In the meantime, you can follow the step-by-step onboarding guide.",
                aiGenerated: false
            };
        }

        try {
            const prompt = `You are a helpful AI assistant for CareOps, a business operations platform. A business owner is setting up their workspace and needs help.

Context: They are on onboarding step ${context.currentStep || 'unknown'} of 8.
Business: ${context.businessName || 'Not yet named'}

Their question: "${message}"

Respond helpfully and concisely (under 100 words). Be warm and professional. If they ask about features, explain how CareOps handles it. Do not use markdown formatting.`;

            const result = await this.model.generateContent(prompt);
            return {
                response: result.response.text(),
                aiGenerated: true
            };
        } catch (error) {
            console.error('Gemini chat error:', error.message);
            return {
                response: "I apologize, but I'm having trouble processing your question right now. Please try again in a moment, or continue with the step-by-step guide.",
                aiGenerated: false
            };
        }
    }

    getDefaultScript(step, stepInfo, businessName) {
        const name = businessName || 'your business';
        const scripts = {
            1: `Welcome to CareOps! I'm your AI setup assistant, and I'm thrilled to help you get ${name} up and running. In this first step, we'll create your workspace, the foundation of everything. You'll enter your business name, physical address if you offer in-person services, your time zone so bookings align, and a contact email for customer communications. This takes just a minute, and once done, we'll move on to connecting your communication channels.`,
            2: `Great job setting up your workspace! Now let's connect your communication channels. This is crucial because it's how your customers will receive booking confirmations, reminders, and follow-ups. You can connect Brevo for email, which handles confirmations and detailed messages, and SMS for quick reminders. At least one channel is required. Don't worry, everything is automated once configured.`,
            3: `Time to create your contact form! This is the front door to ${name}. When a customer fills it out, the system automatically creates their profile, starts a conversation, and sends a welcome message. You'll set up fields for their name, email or phone, and an optional message. Simple but powerful.`,
            4: `Now for the exciting part, setting up your bookings! Define what services or meeting types ${name} offers. For each service, you'll set the name, how long it lasts, where it happens, and when you're available. This automatically generates a beautiful public booking page that your customers can use.`,
            5: `Let's set up your forms. These are documents like intake forms, agreements, or questionnaires that get sent automatically after someone books. Link each form to a service type, and the system handles everything. Customers fill them out before their appointment, and you can track completion in real time.`,
            6: `Smart businesses track their resources, and that's what this step is about. Add the items or supplies you use per booking, set quantities, and define low-stock thresholds. When inventory runs low, you'll get alerts automatically. This prevents those last-minute surprise shortages.`,
            7: `Almost there! Now let's invite your team. You'll send personal invitation links to your staff members. Each person gets customized access, you control whether they can see the inbox, manage bookings, handle forms, or view inventory. They'll get a beautiful email with a one-click join link.`,
            8: `This is the final step! Before we activate ${name}, the system will verify that everything is properly configured, your communication channels, booking types, and availability. Once verified, your workspace goes live. Contact forms start receiving submissions, booking links work, and all automations begin running. You're ready for business!`
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
