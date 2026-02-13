const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const auth = require('../middleware/auth');
const fileStorage = require('../services/fileStorage');
const prisma = require('../lib/prisma');

// ─── Multer config (memory storage for abstraction) ──────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf',
            'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain', 'text/csv'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${file.mimetype} is not allowed`), false);
        }
    }
});

// POST /api/files/upload — Upload a file (authenticated)
router.post('/upload', auth, upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const result = await fileStorage.upload(req.workspaceId, req.file);

        if (!result.success) {
            return res.status(500).json({ error: 'File upload failed' });
        }

        // Log upload in automation log
        await prisma.automationLog.create({
            data: {
                workspaceId: req.workspaceId,
                event: 'file.uploaded',
                action: 'store_file',
                status: 'success',
                details: JSON.stringify({
                    filename: req.file.originalname,
                    size: req.file.size,
                    mimeType: req.file.mimetype
                })
            }
        });

        res.status(201).json(result.file);
    } catch (error) {
        next(error);
    }
});

// POST /api/files/upload-multiple — Upload multiple files
router.post('/upload-multiple', auth, upload.array('files', 5), async (req, res, next) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files provided' });
        }

        const results = [];
        for (const file of req.files) {
            const result = await fileStorage.upload(req.workspaceId, file);
            if (result.success) results.push(result.file);
        }

        res.status(201).json({ files: results, count: results.length });
    } catch (error) {
        next(error);
    }
});

// GET /api/files — List all files for workspace
router.get('/', auth, async (req, res, next) => {
    try {
        const files = await fileStorage.listFiles(req.workspaceId);
        const stats = await fileStorage.getStats(req.workspaceId);
        res.json({ files, stats });
    } catch (error) {
        next(error);
    }
});

// GET /api/files/stats — Storage usage stats
router.get('/stats', auth, async (req, res, next) => {
    try {
        const stats = await fileStorage.getStats(req.workspaceId);
        res.json(stats);
    } catch (error) {
        next(error);
    }
});

// GET /api/files/:workspaceId/:filename — Serve a file (public access for shared links)
router.get('/:workspaceId/:filename', async (req, res, next) => {
    try {
        const storagePath = `${req.params.workspaceId}/${req.params.filename}`;
        const result = await fileStorage.getFile(storagePath);

        if (!result.success) {
            return res.status(404).json({ error: 'File not found' });
        }

        const ext = path.extname(req.params.filename).toLowerCase();
        const mimeTypes = {
            '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
            '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.txt': 'text/plain', '.csv': 'text/csv'
        };

        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        result.stream.pipe(res);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/files/:storagePath — Delete a file
router.delete('/:workspaceId/:filename', auth, async (req, res, next) => {
    try {
        // Verify workspace ownership
        if (req.params.workspaceId !== req.workspaceId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const storagePath = `${req.params.workspaceId}/${req.params.filename}`;
        const result = await fileStorage.delete(storagePath);

        if (!result.success) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.json({ message: 'File deleted' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
