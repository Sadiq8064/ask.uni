const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');
const ragService = require('./rag');
const apiKeyManager = require('./apikey');
const { scrapeWebsite } = require("./webscrapper");

// Database paths
const DB_DIR = path.join(__dirname, 'database');
const UNIVERSITIES_DIR = path.join(DB_DIR, 'universities');
const ACCOUNTS_DIR = path.join(DB_DIR, 'accounts');
const STUDENTS_DIR = path.join(DB_DIR, 'students');
const PENDING_REGISTRATIONS_FILE = path.join(DB_DIR, 'pending_registrations.json');

// Initialize database directories
const initializeDatabase = async () => {
    try {
        await fs.mkdir(DB_DIR, { recursive: true });
        await fs.mkdir(UNIVERSITIES_DIR, { recursive: true });
        await fs.mkdir(ACCOUNTS_DIR, { recursive: true });
        await fs.mkdir(STUDENTS_DIR, { recursive: true });

        // Create pending registrations file if it doesn't exist
        try {
            await fs.access(PENDING_REGISTRATIONS_FILE);
        } catch {
            await fs.writeFile(PENDING_REGISTRATIONS_FILE, JSON.stringify([], null, 2));
        }
    } catch (error) {
        console.error('Database initialization error:', error);
    }
};

// Initialize on module load
initializeDatabase();

// Helper: Read pending registrations
const readPendingRegistrations = async () => {
    try {
        const data = await fs.readFile(PENDING_REGISTRATIONS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
};

// Helper: Write pending registrations
const writePendingRegistrations = async (registrations) => {
    await fs.writeFile(PENDING_REGISTRATIONS_FILE, JSON.stringify(registrations, null, 2));
};

// Helper: Read university data
const readUniversity = async (email) => {
    try {
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(UNIVERSITIES_DIR, `${sanitizedEmail}.json`);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
};

// Helper: Write university data
const writeUniversity = async (email, universityData) => {
    const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const filePath = path.join(UNIVERSITIES_DIR, `${sanitizedEmail}.json`);
    await fs.writeFile(filePath, JSON.stringify(universityData, null, 2));
};

// Helper: Check if university exists
const universityExists = async (email) => {
    try {
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(UNIVERSITIES_DIR, `${sanitizedEmail}.json`);
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

// Helper: Read account data
const readAccount = async (email) => {
    try {
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(ACCOUNTS_DIR, `${sanitizedEmail}.json`);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
};

// Helper: Write account data
const writeAccount = async (email, accountData) => {
    const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const filePath = path.join(ACCOUNTS_DIR, `${sanitizedEmail}.json`);
    await fs.writeFile(filePath, JSON.stringify(accountData, null, 2));
};

// Helper: Check if account exists
const accountExists = async (email) => {
    try {
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(ACCOUNTS_DIR, `${sanitizedEmail}.json`);
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

// Helper: Get all accounts for a university
const getUniversityAccounts = async (universityEmail) => {
    try {
        const files = await fs.readdir(ACCOUNTS_DIR);
        const accounts = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(ACCOUNTS_DIR, file);
                const data = await fs.readFile(filePath, 'utf8');
                const account = JSON.parse(data);
                if (account.universityEmail === universityEmail) {
                    const { password, ...accountData } = account;
                    accounts.push(accountData);
                }
            }
        }

        return accounts;
    } catch (error) {
        console.error('Error getting university accounts:', error);
        return [];
    }
};

async function scrapeAndUploadWebsite(university, geminiApiKey, ragService) {
    try {
        console.log(`\n🌐 Scraping website for: ${university.websiteUrl}`);

        const pages = await scrapeWebsite(university.websiteUrl);

        const jsonPayload = {
            url: university.websiteUrl,
            pages
        };

        const storeName = university.ragStore.storeName;

        const uploadResult = await ragService.uploadFiles(
            geminiApiKey,
            storeName,
            [
                {
                    buffer: Buffer.from(JSON.stringify(jsonPayload)),
                    originalname: "website_content.json"
                }
            ]
        );

        if (!uploadResult.success) {
            console.error("❌ Website upload failed:", uploadResult.error);
            return false;
        }

        console.log("✅ Website content uploaded to store:", storeName);
        return true;

    } catch (err) {
        console.error("❌ Website scraping/upload error:", err);
        return false;
    }
}

// ============================================
// UNIVERSITY REGISTRATION & LOGIN APIs
// ============================================

// API 1: Initial Registration - Email and Password
router.post('/register/initiate', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Password strength validation
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        // Check if email already exists
        const exists = await universityExists(email);
        if (exists) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Check if pending registration exists (by email only)
        const pendingRegistrations = await readPendingRegistrations();
        const existingPending = pendingRegistrations.find(reg => reg.email === email);
        if (existingPending) {
            return res.status(409).json({
                error: 'Registration already in progress for this email',
                email
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create pending registration
        const newRegistration = {
            email,
            password: hashedPassword,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
        };

        pendingRegistrations.push(newRegistration);
        await writePendingRegistrations(pendingRegistrations);

        res.status(201).json({
            message: 'Initial registration successful. Please complete your university details.',
            email
        });
    } catch (error) {
        console.error('Registration initiation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 2: Complete Registration - University Details
router.post('/register/complete', async (req, res) => {
    try {
        const {
            email,
            universityName,
            universityType,
            city,
            state,
            country,
            websiteUrl,
            establishedDate,
            studentEmailExtension,
            description,
            phoneNumber,
            accreditation
        } = req.body;

        // Validation
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Check if pending registration exists (by email only)
        const pendingRegistrations = await readPendingRegistrations();
        const pendingIndex = pendingRegistrations.findIndex(
            reg => reg.email === email
        );

        if (pendingIndex === -1) {
            return res.status(404).json({ error: 'Invalid or expired registration' });
        }

        const pendingReg = pendingRegistrations[pendingIndex];

        // Check if registration has expired
        if (new Date() > new Date(pendingReg.expiresAt)) {
            pendingRegistrations.splice(pendingIndex, 1);
            await writePendingRegistrations(pendingRegistrations);
            return res.status(410).json({ error: 'Registration session expired. Please start again.' });
        }

        // Validate required fields
        const requiredFields = {
            universityName,
            universityType,
            city,
            state,
            country,
            websiteUrl,
            establishedDate,
            studentEmailExtension
        };

        for (const [key, value] of Object.entries(requiredFields)) {
            if (!value) {
                return res.status(400).json({ error: `${key} is required` });
            }
        }

        // Validate university type
        const validTypes = ['Public', 'Private', 'Government', 'Deemed', 'Autonomous'];
        if (!validTypes.includes(universityType)) {
            return res.status(400).json({
                error: `Invalid university type. Must be one of: ${validTypes.join(', ')}`
            });
        }

        // Validate website URL
        const urlRegex = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
        if (!urlRegex.test(websiteUrl)) {
            return res.status(400).json({ error: 'Invalid website URL format' });
        }

        // Validate email extension format
        if (!studentEmailExtension.startsWith('@')) {
            return res.status(400).json({
                error: 'Student email extension must start with @ (e.g., @kletech.ac.in)'
            });
        }

        // Validate established date
        const estDate = new Date(establishedDate);
        if (isNaN(estDate.getTime()) || estDate > new Date()) {
            return res.status(400).json({ error: 'Invalid established date' });
        }

        // Check if API keys are available
        const hasKeys = await apiKeyManager.hasAvailableKeys();
        if (!hasKeys) {
            return res.status(503).json({
                error: 'No API keys available for registration. Please contact administrator.'
            });
        }

        // Create university ID first
        const universityId = `univ_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Assign API key to university
        const keyAssignment = await apiKeyManager.assignKey(email, universityId);
        if (!keyAssignment.success) {
            return res.status(500).json({
                error: `Failed to assign API key: ${keyAssignment.error}`
            });
        }

        const geminiApiKey = keyAssignment.key;
        console.log(`Assigned API key ${keyAssignment.keyId} to university: ${universityName}`);

        // Create RAG store for the university
        console.log(`Creating RAG store for university: ${universityName}`);
        const ragStoreResult = await ragService.initializeUniversityStore(
            geminiApiKey,
            universityName,
            email
        );

        if (!ragStoreResult.success) {
            // Release the API key if RAG store creation fails
            await apiKeyManager.releaseKey(email);
            return res.status(500).json({
                error: `Failed to create document store: ${ragStoreResult.error}`
            });
        }

        const ragStoreName = ragStoreResult.data.store_name;
        const ragStoreResource = ragStoreResult.data.file_search_store_resource;

        console.log(`RAG store created successfully: ${ragStoreName}`);

        // Create university record
        const university = {
            universityId,
            email: pendingReg.email,
            password: pendingReg.password,
            universityName,
            universityType,
            city,
            state,
            country,
            websiteUrl,
            establishedDate: estDate.toISOString(),
            studentEmailExtension,
            description: description || '',
            phoneNumber: phoneNumber || '',
            accreditation: accreditation || '',
            read_website: true,
            isActive: true,
            apiKeyInfo: {
                keyId: keyAssignment.keyId,
                assignedAt: keyAssignment.assignedAt,
                key: keyAssignment.key
            },
            ragStore: {
                storeName: ragStoreName,
                storeResource: ragStoreResource,
                createdAt: new Date().toISOString()
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Background website scraping
        void (async () => {
            try {
                await scrapeAndUploadWebsite(
                    {
                        websiteUrl,
                        ragStore: { storeName: ragStoreName }
                    },
                    geminiApiKey,
                    ragService
                );
                console.log("✅ (BACKGROUND) Website scraped & uploaded.");
            } catch (err) {
                console.error("❌ (BACKGROUND) Scraping error:", err);
            }
        })();

        // Save to database
        await writeUniversity(email, university);

        // Remove from pending registrations
        pendingRegistrations.splice(pendingIndex, 1);
        await writePendingRegistrations(pendingRegistrations);

        // Return response without password
        const { password, ...universityResponse } = university;

        res.status(201).json({
            message: 'University registered successfully with dedicated document store',
            universityId,
            university: universityResponse
        });
    } catch (error) {
        console.error('Registration completion error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 3: Login (supports both admin and account login)
router.post('/login', async (req, res) => {
    try {
        const { email, password, loginType } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (!loginType || !['admin', 'account'].includes(loginType)) {
            return res.status(400).json({ error: 'loginType must be either "admin" or "account"' });
        }

        if (loginType === 'admin') {
            // Admin login - login to university admin account
            const university = await readUniversity(email);
            if (!university) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Verify password
            const isValidPassword = await bcrypt.compare(password, university.password);
            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Check if account is active
            if (!university.isActive) {
                return res.status(403).json({ error: 'Account is deactivated' });
            }

            // Return response without password
            const { password: _, ...universityData } = university;

            res.json({
                message: 'Admin login successful',
                loginType: 'admin',
                data: universityData
            });

        } else if (loginType === 'account') {
            // Account login - login to subaccount created by admin
            const account = await readAccount(email);
            if (!account) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Verify password
            const isValidPassword = await bcrypt.compare(password, account.password);
            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Check if account is active
            if (!account.isActive) {
                return res.status(403).json({ error: 'Account is deactivated' });
            }

            // Get university details (without sensitive info)
            const university = await readUniversity(account.universityEmail);
            const universityInfo = university ? {
                universityName: university.universityName,
                universityEmail: university.email,
                universityType: university.universityType,
                city: university.city,
                state: university.state,
                country: university.country
            } : null;

            // Return response without password
            const { password: __, ...accountData } = account;

            res.json({
                message: 'Account login successful',
                loginType: 'account',
                data: {
                    ...accountData,
                    universityInfo
                }
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 4: Toggle read_website attribute
router.patch("/toggle-website-access", async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: "email is required" });
        }

        const university = await readUniversity(email);
        if (!university) {
            return res.status(404).json({ error: "University not found" });
        }

        // Get Gemini key assigned to this university
        const keyInfo = await apiKeyManager.getKeyForUniversity(email);
        const geminiApiKey = keyInfo.key;

        const storeName = university.ragStore.storeName;
        const storeResource = university.ragStore.storeResource;
        const websiteUrl = university.websiteUrl;

        // Toggle read_website flag
        university.read_website = !university.read_website;
        university.updatedAt = new Date().toISOString();
        await writeUniversity(email, university);

        if (!university.read_website) {
            // READ WEBSITE TURNED OFF - Remove website_content.json
            console.log("\n❌ READ WEBSITE: OFF — Removing website_content.json");

            // Delete website_content.json FROM ADMIN STORE
            try {
                const stats = await ragService.listStores(geminiApiKey);
                const store = stats?.data?.stores?.find(s => s.store_name === storeName);

                if (store?.documents?.length) {
                    for (const doc of store.documents) {
                        if (doc.file_name === "website_content.json") {
                            console.log("🗑 Removing website_content.json...");
                            await ragService.deleteDocument(
                                geminiApiKey,
                                storeName,
                                doc.document_id
                            );
                        }
                    }
                } else {
                    console.log("ℹ No website_content.json found in admin store.");
                }
            } catch (err) {
                console.error("❌ Error deleting website_content.json:", err);
            }

            // REMOVE FROM STUDENTS (IF THEY EXIST)
            try {
                const exists = await fs.access(STUDENTS_DIR).then(() => true).catch(() => false);

                if (!exists) {
                    console.log("ℹ No students directory — skipping student cleanup.");
                } else {
                    const files = await fs.readdir(STUDENTS_DIR);

                    for (const file of files) {
                        const filePath = path.join(STUDENTS_DIR, file);

                        try {
                            const raw = await fs.readFile(filePath, "utf8");
                            const student = JSON.parse(raw);

                            if (student.universityEmail === email) {
                                student.accessibleStores = (student.accessibleStores || [])
                                    .filter(s => s.storeName !== storeName);

                                await fs.writeFile(filePath, JSON.stringify(student, null, 2));
                                console.log(`✔ Removed store from student: ${student.email}`);
                            }
                        } catch {
                            console.log(`Skipping invalid student file: ${file}`);
                        }
                    }
                }
            } catch (err) {
                console.error("❌ Student cleanup error:", err);
            }

            return res.json({
                message: "Website disabled. Store removed from admin and students (if any)."
            });
        }

        // READ WEBSITE TURNED ON - Background scraping
        console.log("\n🟢 READ WEBSITE: ON — Starting BACKGROUND website scraping...");

        // RUN SCRAPING IN BACKGROUND, NON-BLOCKING
        void (async () => {
            try {
                await scrapeAndUploadWebsite(
                    {
                        websiteUrl,
                        ragStore: { storeName }
                    },
                    geminiApiKey,
                    ragService
                );
                console.log("✅ (BACKGROUND) website_content.json scraped & uploaded.");
            } catch (err) {
                console.error("❌ (BACKGROUND) Scraping error:", err);
            }
        })();

        // ADD STORE TO STUDENTS (IF ANY)
        try {
            const exists = await fs.access(STUDENTS_DIR).then(() => true).catch(() => false);

            if (!exists) {
                console.log("ℹ No students directory — skipping student updates.");
            } else {
                const files = await fs.readdir(STUDENTS_DIR);

                for (const file of files) {
                    const filePath = path.join(STUDENTS_DIR, file);

                    try {
                        const raw = await fs.readFile(filePath, "utf8");
                        const student = JSON.parse(raw);

                        if (student.universityEmail === email) {
                            student.accessibleStores = student.accessibleStores || [];

                            const already = student.accessibleStores.some(
                                s => s.storeName === storeName
                            );

                            if (!already) {
                                student.accessibleStores.push({
                                    storeName,
                                    storeResource
                                });

                                await fs.writeFile(filePath, JSON.stringify(student, null, 2));
                                console.log(`✔ Added store to student: ${student.email}`);
                            }
                        }
                    } catch {
                        console.log(`Skipping invalid student file: ${file}`);
                    }
                }
            }
        } catch (err) {
            console.error("❌ Student update error:", err);
        }

        // RETURN INSTANTLY — DO NOT WAIT FOR SCRAPING
        return res.json({
            message: "Website enabled. Background scraping started & students updated."
        });

    } catch (error) {
        console.error("toggle-website-access error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API 5: Get university profile
router.get('/profile/:email', async (req, res) => {
    try {
        const { email } = req.params;

        const university = await readUniversity(email);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        // Return university data without password
        const { password, ...universityData } = university;
        res.json(universityData);
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 6: Update university details
router.put('/profile', async (req, res) => {
    try {
        const { email, ...updates } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const university = await readUniversity(email);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        // Fields that cannot be updated
        const protectedFields = ['universityId', 'email', 'password', 'createdAt', 'apiKeyInfo', 'ragStore'];

        // Remove protected fields from updates
        protectedFields.forEach(field => delete updates[field]);

        // Update university
        Object.assign(university, updates, { updatedAt: new Date().toISOString() });

        // Save updated data
        await writeUniversity(email, university);

        const { password, ...universityData } = university;
        res.json({
            message: 'University profile updated successfully',
            university: universityData
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 7: Delete university + all accounts + all students + all RAG stores
router.delete('/delete-university', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'email is required' });
        }

        // Load university
        const university = await readUniversity(email);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        console.log(`\n========= DELETING UNIVERSITY: ${university.universityName} =========`);

        const geminiApiKeyInfo = await apiKeyManager.getKeyForUniversity(email);
        const geminiApiKey = geminiApiKeyInfo.key;

        // 1. DELETE UNIVERSITY RAG STORE
        if (university.ragStore?.storeName) {
            console.log(`Deleting university RAG store: ${university.ragStore.storeName}`);
            await ragService.deleteStore(geminiApiKey, university.ragStore.storeName);
        }

        // 2. DELETE ALL ACCOUNTS (PRIMARY + NON-PRIMARY)
        const accounts = await getUniversityAccounts(email);
        console.log(`Found ${accounts.length} accounts to delete.`);

        for (const acc of accounts) {
            // Delete account RAG store
            if (acc.ragStore?.storeName) {
                console.log(`Deleting account store: ${acc.accountEmail} | ${acc.ragStore.storeName}`);
                await ragService.deleteStore(geminiApiKey, acc.ragStore.storeName);
            }

            // Delete account JSON file
            const sanitized = acc.accountEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
            const accountPath = path.join(ACCOUNTS_DIR, `${sanitized}.json`);
            await fs.unlink(accountPath);
            console.log(`Deleted account file: ${acc.accountEmail}`);
        }

        // 3. DELETE ALL STUDENTS OF THIS UNIVERSITY
        const studentFiles = await fs.readdir(STUDENTS_DIR);

        for (const file of studentFiles) {
            const filePath = path.join(STUDENTS_DIR, file);
            const data = await fs.readFile(filePath, 'utf8');
            const student = JSON.parse(data);

            if (student.universityEmail === email) {
                await fs.unlink(filePath);
                console.log(`Deleted student: ${student.email}`);
            }
        }

        // 4. RELEASE API KEY
        console.log(`Releasing API key for university: ${email}`);
        await apiKeyManager.releaseKey(email);

        // 5. DELETE UNIVERSITY JSON FILE
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const uniPath = path.join(UNIVERSITIES_DIR, `${sanitizedEmail}.json`);

        await fs.unlink(uniPath);
        console.log(`Deleted university admin file: ${email}`);

        // 6. DELETE PENDING REGISTRATION IF EXISTS
        const pending = await readPendingRegistrations();
        const filtered = pending.filter(p => p.email !== email);
        await writePendingRegistrations(filtered);

        console.log(`Cleaned pending registrations for: ${email}`);
        console.log(`========= UNIVERSITY DELETE COMPLETE =========\n`);

        res.json({
            message: 'University and all associated accounts, students & stores deleted successfully'
        });

    } catch (error) {
        console.error('Delete University error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// ACCOUNT MANAGEMENT APIs (Admin creates accounts)
// ============================================

// API 8: Create Account (Primary or Non-Primary)
router.post('/accounts/create', async (req, res) => {
    try {
        const {
            universityEmail,
            accountEmail,
            accountPassword,
            accountName,
            isPrimary
        } = req.body;

        // Validation
        if (!universityEmail || !accountEmail || !accountPassword || !accountName) {
            return res.status(400).json({
                error: 'universityEmail, accountEmail, accountPassword, and accountName are required'
            });
        }

        if (typeof isPrimary !== 'boolean') {
            return res.status(400).json({ error: 'isPrimary must be a boolean value' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(accountEmail)) {
            return res.status(400).json({ error: 'Invalid account email format' });
        }

        // Password strength validation
        if (accountPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        // Check if university exists
        const university = await readUniversity(universityEmail);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        // CRITICAL SECURITY CHECK: Prevent account email from being used across multiple universities
        const existsAsUniversity = await universityExists(accountEmail);
        const existingAccount = await readAccount(accountEmail);

        if (existsAsUniversity) {
            return res.status(409).json({ error: 'This email is already registered as a university admin' });
        }

        if (existingAccount) {
            // Check if account belongs to a different university
            if (existingAccount.universityEmail !== universityEmail) {
                return res.status(409).json({
                    error: 'This email is already registered to another university. Each account email must be unique.'
                });
            }
            return res.status(409).json({ error: 'This email is already registered as an account' });
        }

        // Get the university's assigned API key
        const keyInfo = await apiKeyManager.getKeyForUniversity(universityEmail);
        if (!keyInfo.success) {
            return res.status(500).json({
                error: 'Failed to get university API key. Please contact administrator.'
            });
        }

        const geminiApiKey = keyInfo.key;

        // Generate store name: accountName_universityName
        const sanitizedAccountName = accountName
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .trim();

        const sanitizedUniversityName = university.universityName
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .trim();

        // Generate accountId FIRST
        const accountId = `acc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Generate UNIQUE store name using accountId
        const storeName = `${sanitizedAccountName}_${sanitizedUniversityName}_${accountId}`;

        // Create RAG store for the account
        console.log(`Creating RAG store for account: ${accountName} under ${university.universityName}`);
        const ragStoreResult = await ragService.createStore(geminiApiKey, storeName);

        if (!ragStoreResult.success) {
            return res.status(500).json({
                error: `Failed to create document store: ${ragStoreResult.error}`
            });
        }

        const ragStoreResource = ragStoreResult.data.file_search_store_resource;
        console.log(`RAG store created successfully: ${storeName}`);

        // Hash password
        const hashedPassword = await bcrypt.hash(accountPassword, 10);

        // Create account record
        const account = {
            accountId,
            accountEmail,
            password: hashedPassword,
            accountName,
            isPrimary,
            universityEmail,
            universityId: university.universityId,
            universityName: university.universityName,
            ragStore: {
                storeName: storeName,
                storeResource: ragStoreResource,
                createdAt: new Date().toISOString()
            },
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Save account to database
        await writeAccount(accountEmail, account);

        // Return response without password
        const { password, ...accountResponse } = account;

        res.status(201).json({
            message: `${isPrimary ? 'Primary' : 'Non-primary'} account created successfully`,
            account: accountResponse
        });
    } catch (error) {
        console.error('Create account error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 9: Get all accounts for a university (admin only)
router.get('/accounts', async (req, res) => {
    try {
        const { universityEmail } = req.query;

        if (!universityEmail) {
            return res.status(400).json({ error: 'universityEmail is required' });
        }

        // Check if university exists
        const university = await readUniversity(universityEmail);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        // Get all accounts for this university
        const accounts = await getUniversityAccounts(universityEmail);

        res.json({
            universityEmail,
            universityName: university.universityName,
            accountCount: accounts.length,
            accounts
        });
    } catch (error) {
        console.error('Get accounts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 10: Get account details by email
router.get('/accounts/:accountEmail', async (req, res) => {
    try {
        // Decode email from URL (IMPORTANT)
        const rawEmail = req.params.accountEmail;
        const accountEmail = decodeURIComponent(rawEmail).trim();

        const { requestingUniversityEmail } = req.query;

        // DEBUG LOG (remove later if needed)
        console.log("🔍 Fetching account:", accountEmail);

        // Read account from file system
        const account = await readAccount(accountEmail);

        if (!account) {
            console.error("❌ Account file not found for:", accountEmail);
            return res.status(404).json({
                error: 'Account not found',
                accountEmail
            });
        }

        // SECURITY CHECK (ownership)
        if (
            requestingUniversityEmail &&
            account.universityEmail !== requestingUniversityEmail
        ) {
            return res.status(403).json({
                error: 'Access denied. This account belongs to a different university.'
            });
        }

        // Fetch university info (safe)
        const university = await readUniversity(account.universityEmail);

        const universityInfo = university
            ? {
                universityName: university.universityName,
                universityEmail: university.email,
                universityType: university.universityType,
                city: university.city,
                state: university.state,
                country: university.country
            }
            : null;

        // Remove password before sending
        const { password, ...accountData } = account;

        // Success response
        return res.json({
            success: true,
            account: accountData,
            universityInfo
        });

    } catch (error) {
        console.error('❌ Get account details error:', error);
        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});

// API 11: Update account details
router.put('/accounts/update', async (req, res) => {
    try {
        const { accountEmail, ...updates } = req.body;

        if (!accountEmail) {
            return res.status(400).json({ error: 'accountEmail is required' });
        }

        const account = await readAccount(accountEmail);
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        // Fields that cannot be updated
        const protectedFields = [
            'accountId',
            'accountEmail',
            'password',
            'universityEmail',
            'universityId',
            'ragStore',
            'createdAt'
        ];

        // Remove protected fields from updates
        protectedFields.forEach(field => delete updates[field]);

        // Update account
        Object.assign(account, updates, { updatedAt: new Date().toISOString() });

        // Save updated data
        await writeAccount(accountEmail, account);

        const { password, ...accountData } = account;
        res.json({
            message: 'Account updated successfully',
            account: accountData
        });
    } catch (error) {
        console.error('Update account error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 12: Delete account
router.delete('/accounts/delete', async (req, res) => {
    try {
        const { accountEmail, universityEmail } = req.body;

        if (!accountEmail || !universityEmail) {
            return res.status(400).json({ error: 'accountEmail and universityEmail are required' });
        }

        // Check if account exists
        const account = await readAccount(accountEmail);
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        // Verify that account belongs to the specified university
        if (account.universityEmail !== universityEmail) {
            return res.status(403).json({
                error: 'This account does not belong to the specified university'
            });
        }

        // Delete account file
        const sanitizedEmail = accountEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(ACCOUNTS_DIR, `${sanitizedEmail}.json`);
        await fs.unlink(filePath);

        res.json({
            message: 'Account deleted successfully',
            accountEmail: accountEmail
        });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 13: Toggle account active status
router.patch('/accounts/toggle-status', async (req, res) => {
    try {
        const { accountEmail, universityEmail } = req.body;

        if (!accountEmail || !universityEmail) {
            return res.status(400).json({ error: 'accountEmail and universityEmail are required' });
        }

        // Check if account exists
        const account = await readAccount(accountEmail);
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }

        // Verify that account belongs to the specified university
        if (account.universityEmail !== universityEmail) {
            return res.status(403).json({
                error: 'This account does not belong to the specified university'
            });
        }

        // Toggle status
        account.isActive = !account.isActive;
        account.updatedAt = new Date().toISOString();

        // Save updated data
        await writeAccount(accountEmail, account);

        res.json({
            message: `Account ${account.isActive ? 'activated' : 'deactivated'} successfully`,
            accountEmail: accountEmail,
            isActive: account.isActive
        });
    } catch (error) {
        console.error('Toggle account status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 14: Verify account ownership (utility endpoint for security checks)
router.post('/accounts/verify-ownership', async (req, res) => {
    try {
        const { accountEmail, universityEmail } = req.body;

        if (!accountEmail || !universityEmail) {
            return res.status(400).json({
                error: 'accountEmail and universityEmail are required'
            });
        }

        // Check if account exists
        const account = await readAccount(accountEmail);
        if (!account) {
            return res.status(404).json({
                error: 'Account not found',
                isOwned: false
            });
        }

        // Verify ownership
        const isOwned = account.universityEmail === universityEmail;

        if (isOwned) {
            res.json({
                message: 'Account belongs to the specified university',
                isOwned: true,
                accountEmail: account.accountEmail,
                accountName: account.accountName,
                universityEmail: account.universityEmail,
                universityName: account.universityName
            });
        } else {
            res.status(403).json({
                message: 'Account belongs to a different university',
                isOwned: false,
                accountEmail: accountEmail
            });
        }
    } catch (error) {
        console.error('Verify account ownership error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;