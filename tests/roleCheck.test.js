const { ownerOnly, checkPermission } = require('../src/middleware/roleCheck');

describe('roleCheck middleware', () => {
    let mockReq, mockRes, mockNext;

    beforeEach(() => {
        mockReq = { user: { role: 'OWNER', permissions: {} } };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        mockNext = jest.fn();
    });

    // ─── ownerOnly ──────────────────────────────────────

    describe('ownerOnly', () => {
        it('should call next() for OWNER role', () => {
            ownerOnly(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
            expect(mockRes.status).not.toHaveBeenCalled();
        });

        it('should return 403 for STAFF role', () => {
            mockReq.user.role = 'STAFF';
            ownerOnly(mockReq, mockRes, mockNext);
            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'Access denied. Owner privileges required.'
            });
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    // ─── checkPermission ────────────────────────────────

    describe('checkPermission', () => {
        it('should call next() for OWNER regardless of permissions', () => {
            const middleware = checkPermission('inbox');
            middleware(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
        });

        it('should call next() for STAFF with required permission', () => {
            mockReq.user.role = 'STAFF';
            mockReq.user.permissions = { inbox: true };
            const middleware = checkPermission('inbox');
            middleware(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
        });

        it('should return 403 for STAFF without required permission', () => {
            mockReq.user.role = 'STAFF';
            mockReq.user.permissions = { inbox: false };
            const middleware = checkPermission('inbox');
            middleware(mockReq, mockRes, mockNext);
            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should return 403 for STAFF with null permissions', () => {
            mockReq.user.role = 'STAFF';
            mockReq.user.permissions = null;
            const middleware = checkPermission('bookings');
            middleware(mockReq, mockRes, mockNext);
            expect(mockRes.status).toHaveBeenCalledWith(403);
        });
    });
});
