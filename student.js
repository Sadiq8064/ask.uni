const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

/**
 * STUDENT MANAGEMENT ROUTES
 *
 * REGISTRATION FLOW:
 * ==================
 * 1. PARTIAL REGISTRATION (/register/initiate):
 *    - Student provides: email, password
 *    - System verifies: email extension matches a university's studentEmailExtension
 *    - If valid university found, student is partially registered
 *
 * 2. GET NON-PRIMARY ACCOUNTS (/register/get-accounts):
 *    - Student gets list of non-primary accounts from their university
 *    - Student selects ONE non-primary account
 *
 * 3. COMPLETE REGISTRATION (/register/complete):
 *    - Student provides: name, selected non-primary account ID
 *    - Student gets access to:
 *      * ALL primary account stores (automatic)
 *      * SELECTED non-primary account store (user choice)
 *
 * DATA STRUCTURE:
 * ===============
 * database/
 * ├── students/
 * │   ├── student1@kletech.ac.in.json
 * │   └── student2@kletech.ac.in.json
 *
 * Each student JSON contains:
 * - studentId, email, password, name
 * - universityEmail, universityName
 * - accessibleStores: [
 *     { accountName, accountEmail, storeName, isPrimary, storeResource }
 *   ]
 */

// Database paths
const DB_DIR = path.join(__dirname, 'database');
const STUDENTS_DIR = path.join(DB_DIR, 'students');
const UNIVERSITIES_DIR = path.join(DB_DIR, 'universities');
const ACCOUNTS_DIR = path.join(DB_DIR, 'accounts');
const PENDING_STUDENT_REG_FILE = path.join(DB_DIR, 'pending_student_registrations.json');

// Initialize database directories
const initializeDatabase = async () => {
    try {
        await fs.mkdir(STUDENTS_DIR, { recursive: true });

        try {
            await fs.access(PENDING_STUDENT_REG_FILE);
        } catch {
            await fs.writeFile(PENDING_STUDENT_REG_FILE, JSON.stringify([], null, 2));
        }
    } catch (error) {
        console.error('Database initialization error:', error);
    }
};

initializeDatabase();

// Helper: Read pending student registrations
const readPendingStudentRegistrations = async () => {
    try {
        const data = await fs.readFile(PENDING_STUDENT_REG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
};

// Helper: Write pending student registrations
const writePendingStudentRegistrations = async (registrations) => {
    await fs.writeFile(PENDING_STUDENT_REG_FILE, JSON.stringify(registrations, null, 2));
};

// Helper: Read student data
const readStudent = async (email) => {
    try {
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(STUDENTS_DIR, `${sanitizedEmail}.json`);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
};

// Helper: Write student data
const writeStudent = async (email, studentData) => {
    const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const filePath = path.join(STUDENTS_DIR, `${sanitizedEmail}.json`);
    await fs.writeFile(filePath, JSON.stringify(studentData, null, 2));
};

// Helper: Check if student exists
const studentExists = async (email) => {
    try {
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(STUDENTS_DIR, `${sanitizedEmail}.json`);
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

// Helper: Find university by email extension
const findUniversityByEmailExtension = async (studentEmail) => {
    try {
        const emailParts = studentEmail.split('@');
        if (emailParts.length !== 2) return null;

        const emailExtension = `@${emailParts[1]}`;
        const files = await fs.readdir(UNIVERSITIES_DIR);

        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(UNIVERSITIES_DIR, file);
                const data = await fs.readFile(filePath, 'utf8');
                const university = JSON.parse(data);

                if (university.studentEmailExtension === emailExtension) {
                    return university;
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error finding university:', error);
        return null;
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
                    accounts.push(account);
                }
            }
        }

        return accounts;
    } catch (error) {
        console.error('Error getting university accounts:', error);
        return [];
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

// ============================================
// STUDENT REGISTRATION APIs
// ============================================

/**
 * STUDENT MANAGEMENT ROUTES
 *
 * REGISTRATION FLOW (2 APIs, EMAIL-BASED):
 * =======================================
 * 1. PARTIAL REGISTRATION (/register/initiate):
 *    - Student provides: email, password
 *    - System verifies: email extension matches a university's studentEmailExtension
 *    - System creates pending registration (keyed by email)
 *    - System returns: university info + list of NON-PRIMARY accounts
 *
 * 2. COMPLETE REGISTRATION (/register/complete):
 *    - Student provides: email, name, selectedNonPrimaryAccountEmail
 *    - System:
 *        * Loads pending registration by email
 *        * Validates selected account belongs to same university & is non-primary
 *        * Gives access to:
 *            - ALL PRIMARY account stores
 *            - SELECTED NON-PRIMARY account store
 */

// ============================================
// STUDENT REGISTRATION APIs
// ============================================
// ================================
// STUDENT SUPPORT TICKET SYSTEM (STUDENT ONLY)
// ================================

const TICKETS_DIR = path.join(DB_DIR, "tickets");

// Ensure ticket directory exists
(async () => {
    await fs.mkdir(TICKETS_DIR, { recursive: true });
})();

// Helper: Write ticket
const writeTicket = async (ticketId, data) => {
    const file = path.join(TICKETS_DIR, `${ticketId}.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2));
};

// Helper: Read all tickets for a student
const getTicketsByEmail = async (email) => {
    const files = await fs.readdir(TICKETS_DIR);
    const result = [];

    for (const file of files) {
        if (file.endsWith(".json")) {
            const ticket = JSON.parse(
                await fs.readFile(path.join(TICKETS_DIR, file), "utf8")
            );
            if (ticket.studentEmail === email) result.push(ticket);
        }
    }

    return result;
};

// ===============================================
// API 1 (STUDENT): Create Ticket
// ===============================================
router.post("/ticket/create", async (req, res) => {
    try {
        const { studentEmail, accountEmail, problem } = req.body;

        if (!studentEmail || !accountEmail || !problem) {
            return res.status(400).json({
                error: "studentEmail, accountEmail and problem are required"
            });
        }

        // Validate student exists
        const student = await readStudent(studentEmail);
        if (!student) {
            return res.status(404).json({
                error: "Student not found"
            });
        }

        // Validate department account exists and belongs to the same university
        const account = await readAccount(accountEmail);
        if (!account) {
            return res.status(404).json({
                error: "Department account not found"
            });
        }

        if (account.universityEmail !== student.universityEmail) {
            return res.status(403).json({
                error: "This department does not belong to your university"
            });
        }

        // Generate unique ticket ID
        const ticketId =
            "ticket_" +
            Date.now() +
            "_" +
            Math.random().toString(36).substring(2, 10);

        const ticket = {
            ticketId,
            studentEmail,
            accountEmail,
            universityEmail: student.universityEmail,
            problem,
            status: "pending",
            solution: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await writeTicket(ticketId, ticket);

        res.status(201).json({
            message: "Ticket created successfully",
            ticket
        });
    } catch (error) {
        console.error("Create ticket error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ===============================================
// API 2 (STUDENT): Get All Tickets for a Student
// ===============================================
router.get("/ticket/list/:email", async (req, res) => {
    try {
        const { email } = req.params;

        const student = await readStudent(email);
        if (!student) {
            return res.status(404).json({
                error: "Student not found"
            });
        }

        const tickets = await getTicketsByEmail(email);

        res.json({
            studentEmail: email,
            totalTickets: tickets.length,
            tickets
        });
    } catch (error) {
        console.error("Get tickets error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API 1: Initiate Student Registration (Partial Registration)
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

        // Check if student already exists
        const exists = await studentExists(email);
        if (exists) {
            return res.status(409).json({ error: 'Student email already registered' });
        }

        // Check if pending registration exists (by email only)
        const pendingRegistrations = await readPendingStudentRegistrations();
        const existingPending = pendingRegistrations.find(reg => reg.email === email);
        if (existingPending) {
            return res.status(409).json({
                error: 'Registration already in progress for this email',
                email,
                universityName: existingPending.universityName
            });
        }

        // Find university by email extension
        const university = await findUniversityByEmailExtension(email);
        if (!university) {
            return res.status(404).json({
                error: 'No university found for this email domain. Please check your email address.'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create pending registration (NO registrationId)
        const newRegistration = {
            email,
            password: hashedPassword,
            universityEmail: university.email,
            universityName: university.universityName,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
        };

        pendingRegistrations.push(newRegistration);
        await writePendingStudentRegistrations(pendingRegistrations);

        // Get all accounts for the university and return NON-PRIMARY accounts
        const allAccounts = await getUniversityAccounts(university.email);
        const nonPrimaryAccounts = allAccounts
            .filter(account => !account.isPrimary && account.isActive)
            .map(account => ({
                accountEmail: account.accountEmail,
                accountName: account.accountName,
                storeName: account.ragStore?.storeName
            }));

        res.status(201).json({
            message: 'Partial registration successful. Please select one non-primary account to complete registration.',
            email,
            universityName: university.universityName,
            universityEmail: university.email,
            nonPrimaryAccounts
        });
    } catch (error) {
        console.error('Student registration initiation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// API 2: Complete Student Registration (using email only)
router.post('/register/complete', async (req, res) => {
    try {
        const {
            email,
            name,
            selectedNonPrimaryAccountEmail
        } = req.body;

        // Validation
        if (!email || !name || !selectedNonPrimaryAccountEmail) {
            return res.status(400).json({
                error: 'email, name, and selectedNonPrimaryAccountEmail are required'
            });
        }

        // Find pending registration (by email only)
        const pendingRegistrations = await readPendingStudentRegistrations();
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
            await writePendingStudentRegistrations(pendingRegistrations);
            return res.status(410).json({ error: 'Registration session expired. Please start again.' });
        }

        // Verify selected non-primary account exists and belongs to the university
        const selectedAccount = await readAccount(selectedNonPrimaryAccountEmail);
        if (!selectedAccount) {
            return res.status(404).json({ error: 'Selected account not found' });
        }

        if (selectedAccount.universityEmail !== pendingReg.universityEmail) {
            return res.status(403).json({
                error: 'Selected account does not belong to your university'
            });
        }

        if (selectedAccount.isPrimary) {
            return res.status(400).json({
                error: 'You can only select non-primary accounts'
            });
        }

        // Get all accounts for the university
        const allAccounts = await getUniversityAccounts(pendingReg.universityEmail);

        // Build accessible stores list
        const accessibleStores = [];

        // Add all PRIMARY account stores
        allAccounts
            .filter(account => account.isPrimary && account.isActive)
            .forEach(account => {
                accessibleStores.push({
                    storeName: account.ragStore?.storeName,
                    storeResource: account.ragStore?.storeResource,
                    accountEmail: account.accountEmail   // ✅ added
                });
            });

        // Add selected non-primary
        accessibleStores.push({
            storeName: selectedAccount.ragStore?.storeName,
            storeResource: selectedAccount.ragStore?.storeResource,
            accountEmail: selectedAccount.accountEmail  // ✅ added
        });

        // Create student record
        const studentId = `stu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const student = {
            studentId,
            email: pendingReg.email,
            password: pendingReg.password,
            name,
            universityEmail: pendingReg.universityEmail,
            universityName: pendingReg.universityName,
            selectedNonPrimaryAccount: {
                accountId: selectedAccount.accountId,
                accountEmail: selectedAccount.accountEmail,
                accountName: selectedAccount.accountName
            },
            accessibleStores,
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Save to database
        await writeStudent(pendingReg.email, student);

        // Remove from pending registrations
        pendingRegistrations.splice(pendingIndex, 1);
        await writePendingStudentRegistrations(pendingRegistrations);

        // Return response without password
        const { password, ...studentResponse } = student;

        res.status(201).json({
            message: 'Student registration completed successfully',
            studentId,
            student: studentResponse
        });
    } catch (error) {
        console.error('Student registration completion error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 3: Complete Student Registration
router.post('/register/complete', async (req, res) => {
    try {
        const {
            registrationId,
            name,
            selectedNonPrimaryAccountEmail
        } = req.body;

        // Validation
        if (!registrationId || !name || !selectedNonPrimaryAccountEmail) {
            return res.status(400).json({
                error: 'registrationId, name, and selectedNonPrimaryAccountEmail are required'
            });
        }

        // Find pending registration
        const pendingRegistrations = await readPendingStudentRegistrations();
        const pendingIndex = pendingRegistrations.findIndex(
            reg => reg.registrationId === registrationId
        );

        if (pendingIndex === -1) {
            return res.status(404).json({ error: 'Invalid or expired registration' });
        }

        const pendingReg = pendingRegistrations[pendingIndex];

        // Check if registration has expired
        if (new Date() > new Date(pendingReg.expiresAt)) {
            pendingRegistrations.splice(pendingIndex, 1);
            await writePendingStudentRegistrations(pendingRegistrations);
            return res.status(410).json({ error: 'Registration session expired. Please start again.' });
        }

        // Verify selected non-primary account exists and belongs to the university
        const selectedAccount = await readAccount(selectedNonPrimaryAccountEmail);
        if (!selectedAccount) {
            return res.status(404).json({ error: 'Selected account not found' });
        }

        if (selectedAccount.universityEmail !== pendingReg.universityEmail) {
            return res.status(403).json({
                error: 'Selected account does not belong to your university'
            });
        }

        if (selectedAccount.isPrimary) {
            return res.status(400).json({
                error: 'You can only select non-primary accounts'
            });
        }

        // Get all accounts for the university
        const allAccounts = await getUniversityAccounts(pendingReg.universityEmail);

        // Build accessible stores list
        const accessibleStores = [];

        // Add all PRIMARY account stores
        allAccounts
            .filter(account => account.isPrimary && account.isActive)
            .forEach(account => {
                accessibleStores.push({
                    storeName: account.ragStore?.storeName,
                    storeResource: account.ragStore?.storeResource
                });
            });

        // Add the SELECTED non-primary account store
        accessibleStores.push({
            storeName: selectedAccount.ragStore?.storeName,
            storeResource: selectedAccount.ragStore?.storeResource
        });

        // Create student record
        const studentId = `stu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const student = {
            studentId,
            email: pendingReg.email,
            password: pendingReg.password,
            name,
            universityEmail: pendingReg.universityEmail,
            universityName: pendingReg.universityName,
            selectedNonPrimaryAccount: {
                accountId: selectedAccount.accountId,
                accountEmail: selectedAccount.accountEmail,
                accountName: selectedAccount.accountName
            },
            accessibleStores,
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Save to database
        await writeStudent(pendingReg.email, student);

        // Remove from pending registrations
        pendingRegistrations.splice(pendingIndex, 1);
        await writePendingStudentRegistrations(pendingRegistrations);

        // Return response without password
        const { password, ...studentResponse } = student;

        res.status(201).json({
            message: 'Student registration completed successfully',
            studentId,
            student: studentResponse
        });
    } catch (error) {
        console.error('Student registration completion error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STUDENT LOGIN & PROFILE APIs
// ============================================

// API 4: Student Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find student
        const student = await readStudent(email);
        if (!student) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, student.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Check if account is active
        if (!student.isActive) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Return response without password
        const { password: _, ...studentData } = student;

        res.json({
            message: 'Student login successful',
            student: studentData
        });
    } catch (error) {
        console.error('Student login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 5: Get Student Profile
router.get('/profile/:email', async (req, res) => {
    try {
        const { email } = req.params;

        const student = await readStudent(email);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Return student data without password
        const { password, ...studentData } = student;
        res.json(studentData);
    } catch (error) {
        console.error('Get student profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 6: Get Accessible Accounts (Primary + Selected Non-Primary)
router.get('/accessible-accounts/:email', async (req, res) => {
    try {
        const { email } = req.params;

        const student = await readStudent(email);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Return only account names and emails
        // Get all accounts to map store names back to account info
        const allAccounts = await getUniversityAccounts(student.universityEmail);

        const accounts = [];

        // Map each store to its account information
        for (const store of student.accessibleStores) {
            const account = allAccounts.find(acc => acc.ragStore?.storeName === store.storeName);
            if (account) {
                accounts.push({
                    accountName: account.accountName,
                    accountEmail: account.accountEmail
                });
            }
        }

        res.json({
            studentEmail: student.email,
            studentName: student.name,
            universityName: student.universityName,
            totalAccessibleAccounts: accounts.length,
            accounts
        });
    } catch (error) {
        console.error('Get accessible accounts error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 7: Get All Accessible Store Names
router.get('/accessible-stores/:email', async (req, res) => {
    try {
        const { email } = req.params;

        const student = await readStudent(email);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Return store names only
        const storeNames = student.accessibleStores.map(store => store.storeName);

        res.json({
            studentEmail: student.email,
            universityName: student.universityName,
            totalStores: storeNames.length,
            storeNames
        });
    } catch (error) {
        console.error('Get accessible stores error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 8: Update Student Profile
router.put('/profile', async (req, res) => {
    try {
        const { email, ...updates } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const student = await readStudent(email);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Fields that cannot be updated
        const protectedFields = [
            'studentId',
            'email',
            'password',
            'universityEmail',
            'universityName',
            'selectedNonPrimaryAccount',
            'accessibleStores',
            'createdAt'
        ];

        // Remove protected fields from updates
        protectedFields.forEach(field => delete updates[field]);

        // Update student
        Object.assign(student, updates, { updatedAt: new Date().toISOString() });

        // Save updated data
        await writeStudent(email, student);

        const { password, ...studentData } = student;
        res.json({
            message: 'Student profile updated successfully',
            student: studentData
        });
    } catch (error) {
        console.error('Update student profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 9: Get All Students for a University (Admin only)
router.get('/university/:universityEmail', async (req, res) => {
    try {
        const { universityEmail } = req.params;

        const files = await fs.readdir(STUDENTS_DIR);
        const students = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(STUDENTS_DIR, file);
                const data = await fs.readFile(filePath, 'utf8');
                const student = JSON.parse(data);

                if (student.universityEmail === universityEmail) {
                    const { password, ...studentData } = student;
                    students.push(studentData);
                }
            }
        }

        res.json({
            universityEmail,
            studentCount: students.length,
            students
        });
    } catch (error) {
        console.error('Get university students error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;