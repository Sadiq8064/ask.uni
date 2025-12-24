const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const ImageKit = require("imagekit");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const RAGService = require('./rag');

const DB_DIR = path.join(__dirname, 'database');
const ACCOUNTS_DIR = path.join(DB_DIR, 'accounts');
const UPLOADS_DIR = path.join(DB_DIR, 'uploads');
const TICKETS_DIR = path.join(DB_DIR, 'tickets');

// Ensure required folders exist
(async () => {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.mkdir(TICKETS_DIR, { recursive: true });
})();

// ImageKit Config
const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
});

// ------------------------------
// Helpers
// ------------------------------
const readAccount = async (email) => {
    try {
        const file = path.join(ACCOUNTS_DIR, `${email}.json`);
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return null;
    }
};

const readUploads = async (email) => {
    try {
        const file = path.join(UPLOADS_DIR, `${email}.json`);
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return { notice: [], faq: [], impData: [] };
    }
};

const writeUploads = async (email, data) => {
    const file = path.join(UPLOADS_DIR, `${email}.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2));
};

const readTicket = async (id) => {
    try {
        const file = path.join(TICKETS_DIR, `${id}.json`);
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return null;
    }
};

const writeTicket = async (id, data) => {
    const file = path.join(TICKETS_DIR, `${id}.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2));
};

// ------------------------------
// 1️⃣ Account Login
// ------------------------------
router.post('/login', async (req, res) => {
    try {
        const { accountEmail, password } = req.body;

        if (!accountEmail || !password)
            return res.status(400).json({ error: "accountEmail and password required" });

        const acc = await readAccount(accountEmail);
        if (!acc) return res.status(404).json({ error: "Account not found" });

        // 🔐 Compare hashed password with plain text
        const bcrypt = require("bcrypt");
        const match = await bcrypt.compare(password, acc.password);

        if (!match)
            return res.status(401).json({ error: "Invalid password" });

        res.json({ message: "Login successful", account: acc });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});


// ------------------------------
// 2️⃣ Get ALL Tickets For Department
// ------------------------------
router.get('/tickets/:accountEmail', async (req, res) => {
    try {
        const { accountEmail } = req.params;
        const account = await readAccount(accountEmail);

        if (!account)
            return res.status(404).json({ error: "Account not found" });

        const departmentEmail = account.universityEmail;

        // Get all accounts for this department
        const allAccFiles = await fs.readdir(ACCOUNTS_DIR);
        let departmentAccounts = [];

        for (const a of allAccFiles) {
            if (a.endsWith(".json")) {
                const accData = JSON.parse(await fs.readFile(path.join(ACCOUNTS_DIR, a), "utf8"));
                if (accData.universityEmail === departmentEmail) {
                    departmentAccounts.push(accData.accountEmail);
                }
            }
        }

        // Fetch tickets for all accounts in this department
        const ticketFiles = await fs.readdir(TICKETS_DIR);
        let pending = [], completed = [];

        for (const file of ticketFiles) {
            if (file.endsWith(".json")) {
                const t = JSON.parse(await fs.readFile(path.join(TICKETS_DIR, file), "utf8"));
                if (departmentAccounts.includes(t.accountEmail)) {
                    if (t.status === "pending") pending.push(t);
                    else completed.push(t);
                }
            }
        }

        res.json({
            departmentEmail,
            totalPending: pending.length,
            totalCompleted: completed.length,
            pending,
            completed
        });

    } catch (err) {
        console.error("Get tickets error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ------------------------------
// 3️⃣ Solve Ticket
// ------------------------------
router.put('/ticket/solve', async (req, res) => {
    try {
        const { ticketId, solution } = req.body;

        if (!ticketId || !solution)
            return res.status(400).json({ error: "ticketId & solution required" });

        const ticket = await readTicket(ticketId);
        if (!ticket)
            return res.status(404).json({ error: "Ticket not found" });

        ticket.solution = solution;
        ticket.status = "completed";
        ticket.updatedAt = new Date().toISOString();

        await writeTicket(ticketId, ticket);

        res.json({ message: "Ticket marked as completed", ticket });

    } catch (err) {
        console.error("Solve ticket error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ------------------------------
// 4️⃣ Upload File (ImageKit + RAG)
// ------------------------------
router.post('/upload/:accountEmail', upload.single("file"), async (req, res) => {
    try {
        const { accountEmail } = req.params;
        const { category } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: "File required" });
        if (!["notice", "faq", "impData"].includes(category))
            return res.status(400).json({ error: "Invalid category" });

        const acc = await readAccount(accountEmail);
        if (!acc) return res.status(404).json({ error: "Account not found" });

        // Upload to ImageKit
        const ikUpload = await imagekit.upload({
            file: file.buffer.toString("base64"),
            fileName: file.originalname
        });

        // Upload to RAG store
        // Load university file to get API key
        const universityFile = path.join(DB_DIR, 'universities', `${acc.universityEmail}.json`);
        const university = JSON.parse(await fs.readFile(universityFile, "utf8"));

        const geminiKey = university.apiKeyInfo.key;

        const ragUpload = await RAGService.uploadFiles(
            geminiKey,                      // ✅ Correct Gemini key
            acc.ragStore.storeName,
            [
                {
                    buffer: file.buffer,
                    originalname: file.originalname
                }
            ]
        );


        const uploads = await readUploads(accountEmail);

        uploads[category].push({
            filename: file.originalname,
            imagekitUrl: ikUpload.url,
            imagekitFileId: ikUpload.fileId,
            ragData: ragUpload.data || null,
            uploadedAt: new Date().toISOString()
        });

        await writeUploads(accountEmail, uploads);

        res.json({ message: "File uploaded", uploads });

    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({
            error: "Internal server error",
            details: err?.message || err
        });
    }

});

// ------------------------------
// 5️⃣ Delete File (ImageKit + RAG)
// ------------------------------
router.delete('/upload/delete/:accountEmail', async (req, res) => {
    try {
        const { accountEmail } = req.params;
        const { category, filename } = req.body;

        if (!category || !filename)
            return res.status(400).json({ error: "category & filename required" });

        const acc = await readAccount(accountEmail);
        if (!acc) return res.status(404).json({ error: "Account not found" });

        const uploads = await readUploads(accountEmail);

        const fileEntry = uploads[category].find(f => f.filename === filename);
        if (!fileEntry)
            return res.status(404).json({ error: "File not found" });

        // Delete from ImageKit
        await imagekit.deleteFile(fileEntry.imagekitFileId);

        // Delete from RAG store
        if (fileEntry.ragData?.documentId) {
            await RAGService.deleteDocument(
                acc.apiKey,
                acc.ragStore.storeName,
                fileEntry.ragData.documentId
            );
        }

        // Remove from JSON
        uploads[category] = uploads[category].filter(f => f.filename !== filename);

        await writeUploads(accountEmail, uploads);

        res.json({ message: "File deleted successfully", uploads });

    } catch (err) {
        console.error("Delete file error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ------------------------------
// 6️⃣ Get All Uploads
// ------------------------------
router.get('/uploads/:accountEmail', async (req, res) => {
    try {
        const uploads = await readUploads(req.params.accountEmail);
        res.json(uploads);
    } catch (err) {
        console.error("Get uploads error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;
