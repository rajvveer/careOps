const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const aiOnboarding = require('../services/aiOnboarding');

// POST /api/ai/onboarding-guide - Get AI voice script for onboarding step
router.post('/onboarding-guide', auth, async (req, res, next) => {
    try {
        const { step } = req.body;
        const workspace = req.user.workspace;

        if (!step || step < 1 || step > 8) {
            return res.status(400).json({ error: 'Step must be between 1 and 8' });
        }

        const guide = await aiOnboarding.generateVoiceScript(
            step,
            workspace?.name,
            req.body.businessType
        );

        res.json(guide);
    } catch (error) {
        next(error);
    }
});

// POST /api/ai/chat - Conversational AI assistant
router.post('/chat', auth, async (req, res, next) => {
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const response = await aiOnboarding.generateChatResponse(message, {
            currentStep: req.user.workspace?.onboardingStep,
            businessName: req.user.workspace?.name
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

module.exports = router;
