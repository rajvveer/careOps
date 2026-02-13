const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── File Storage Service (Abstracted) ───────────────────
// Default: local disk storage
// Can be swapped to S3/GCS by changing the provider methods

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

class FileStorageService {
    constructor() {
        // Ensure upload directory exists
        if (!fs.existsSync(UPLOAD_DIR)) {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        }
    }

    // ─── Upload a file ─────────────────────────────────────
    async upload(workspaceId, file) {
        const ext = path.extname(file.originalname);
        const fileId = uuidv4();
        const filename = `${workspaceId}/${fileId}${ext}`;
        const wsDir = path.join(UPLOAD_DIR, workspaceId);

        if (!fs.existsSync(wsDir)) {
            fs.mkdirSync(wsDir, { recursive: true });
        }

        const filePath = path.join(UPLOAD_DIR, filename);
        fs.writeFileSync(filePath, file.buffer);

        return {
            success: true,
            file: {
                id: fileId,
                filename: file.originalname,
                storagePath: filename,
                mimeType: file.mimetype,
                size: file.size,
                url: `/api/files/${workspaceId}/${fileId}${ext}`
            }
        };
    }

    // ─── Get file by path ──────────────────────────────────
    async getFile(storagePath) {
        const filePath = path.join(UPLOAD_DIR, storagePath);
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        return {
            success: true,
            path: filePath,
            stream: fs.createReadStream(filePath)
        };
    }

    // ─── Delete a file ─────────────────────────────────────
    async delete(storagePath) {
        const filePath = path.join(UPLOAD_DIR, storagePath);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return { success: true };
        }
        return { success: false, error: 'File not found' };
    }

    // ─── List files for a workspace ────────────────────────
    async listFiles(workspaceId) {
        const wsDir = path.join(UPLOAD_DIR, workspaceId);
        if (!fs.existsSync(wsDir)) return [];

        const files = fs.readdirSync(wsDir);
        return files.map(f => {
            const filePath = path.join(wsDir, f);
            const stats = fs.statSync(filePath);
            return {
                filename: f,
                storagePath: `${workspaceId}/${f}`,
                size: stats.size,
                uploadedAt: stats.mtime,
                url: `/api/files/${workspaceId}/${f}`
            };
        });
    }

    // ─── Get storage stats ─────────────────────────────────
    async getStats(workspaceId) {
        const files = await this.listFiles(workspaceId);
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        return {
            fileCount: files.length,
            totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
        };
    }
}

module.exports = new FileStorageService();
