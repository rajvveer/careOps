const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);

    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
    }

    if (err.code === 'P2002') {
        return res.status(409).json({ error: 'A record with this value already exists' });
    }

    if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Record not found' });
    }

    res.status(err.statusCode || 500).json({
        error: err.message || 'Internal server error'
    });
};

module.exports = errorHandler;
