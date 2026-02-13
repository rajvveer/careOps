const jwt = require('jsonwebtoken');

// Mock prisma
jest.mock('../src/lib/prisma', () => ({
    user: {
        findUnique: jest.fn()
    }
}));

const prisma = require('../src/lib/prisma');
const auth = require('../src/middleware/auth');

describe('Auth Middleware', () => {
    let mockReq, mockRes, mockNext;

    beforeEach(() => {
        mockReq = { header: jest.fn() };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        mockNext = jest.fn();
        process.env.JWT_SECRET = 'test-secret-key';
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should return 401 if no Authorization header', async () => {
        mockReq.header.mockReturnValue(undefined);
        await auth(mockReq, mockRes, mockNext);
        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
        expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 for invalid token', async () => {
        mockReq.header.mockReturnValue('Bearer invalid-token');
        await auth(mockReq, mockRes, mockNext);
        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    });

    it('should return 401 if user not found', async () => {
        const token = jwt.sign({ userId: 'nonexistent' }, 'test-secret-key');
        mockReq.header.mockReturnValue(`Bearer ${token}`);
        prisma.user.findUnique.mockResolvedValue(null);

        await auth(mockReq, mockRes, mockNext);
        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'User not found' });
    });

    it('should set req.user and req.workspaceId for valid token', async () => {
        const token = jwt.sign({ userId: 'user-123' }, 'test-secret-key');
        mockReq.header.mockReturnValue(`Bearer ${token}`);

        const mockUser = {
            id: 'user-123',
            email: 'test@test.com',
            name: 'Test User',
            role: 'OWNER',
            workspaceId: 'ws-456',
            workspace: { id: 'ws-456', name: 'Test Workspace' },
            permissions: {}
        };
        prisma.user.findUnique.mockResolvedValue(mockUser);

        await auth(mockReq, mockRes, mockNext);
        expect(mockReq.user).toEqual(mockUser);
        expect(mockReq.workspaceId).toBe('ws-456');
        expect(mockNext).toHaveBeenCalled();
    });

    it('should return 401 for expired token', async () => {
        const token = jwt.sign({ userId: 'user-123' }, 'test-secret-key', { expiresIn: '0s' });
        mockReq.header.mockReturnValue(`Bearer ${token}`);

        // Small delay to ensure token is expired
        await new Promise(resolve => setTimeout(resolve, 10));

        await auth(mockReq, mockRes, mockNext);
        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    });
});
