const ownerOnly = (req, res, next) => {
    if (req.user.role !== 'OWNER') {
        return res.status(403).json({ error: 'Access denied. Owner privileges required.' });
    }
    next();
};

const checkPermission = (permission) => {
    return (req, res, next) => {
        if (req.user.role === 'OWNER') return next();

        if (!req.user.permissions || !req.user.permissions[permission]) {
            return res.status(403).json({ error: `Access denied. Missing permission: ${permission}` });
        }
        next();
    };
};

module.exports = { ownerOnly, checkPermission };
