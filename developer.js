const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const apiKeyManager = require('./apikey');

// Database paths
const DB_DIR = path.join(__dirname, 'database');
const UNIVERSITIES_DIR = path.join(DB_DIR, 'universities');
const ACCOUNTS_DIR = path.join(DB_DIR, 'accounts');

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

// ============================================
// SYSTEM ADMIN APIs (Developer/Application Admin)
// ============================================

// API 1: Get all universities (system admin purpose)
router.get('/universities/all', async (req, res) => {
    try {
        const files = await fs.readdir(UNIVERSITIES_DIR);
        const universities = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(UNIVERSITIES_DIR, file);
                const data = await fs.readFile(filePath, 'utf8');
                const university = JSON.parse(data);
                const { password, ...universityData } = university;
                universities.push(universityData);
            }
        }

        res.json({
            count: universities.length,
            universities
        });
    } catch (error) {
        console.error('Get all universities error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 2: Get university details by email
router.get('/universities/:email', async (req, res) => {
    try {
        const { email } = req.params;

        const university = await readUniversity(email);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        // Get all accounts for this university
        const accounts = await getUniversityAccounts(email);

        // Return university data without password
        const { password, ...universityData } = university;

        res.json({
            university: universityData,
            accounts: {
                count: accounts.length,
                list: accounts
            }
        });
    } catch (error) {
        console.error('Get university details error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 3: Get API key statistics (system admin only)
router.get('/api-keys/stats', async (req, res) => {
    try {
        const stats = await apiKeyManager.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Get API key stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 4: Get all API keys with details (system admin only)
router.get('/api-keys', async (req, res) => {
    try {
        const result = await apiKeyManager.getAllKeys();
        res.json(result);
    } catch (error) {
        console.error('Get all API keys error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 5: Add new API key (system admin only)
router.post('/api-keys', async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        const result = await apiKeyManager.addKey(apiKey);

        if (result.success) {
            res.status(201).json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Add API key error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 6: Release API key from a university (system admin only)
router.post('/api-keys/release', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'University email is required' });
        }

        const result = await apiKeyManager.releaseKey(email);
        res.json(result);
    } catch (error) {
        console.error('Release API key error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 7: Delete API key from pool (system admin only)
router.delete('/api-keys/:keyId', async (req, res) => {
    try {
        const { keyId } = req.params;

        if (!keyId) {
            return res.status(400).json({ error: 'API key ID is required' });
        }

        const result = await apiKeyManager.deleteKey(keyId);

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Delete API key error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 8: Reassign API key to different university (system admin only)
router.post('/api-keys/reassign', async (req, res) => {
    try {
        const { fromEmail, toEmail } = req.body;

        if (!fromEmail || !toEmail) {
            return res.status(400).json({
                error: 'Both fromEmail and toEmail are required'
            });
        }

        if (fromEmail === toEmail) {
            return res.status(400).json({
                error: 'Cannot reassign to the same university'
            });
        }

        // Check if target university exists
        const targetUniversity = await readUniversity(toEmail);
        if (!targetUniversity) {
            return res.status(404).json({
                error: 'Target university not found'
            });
        }

        // Check if target university already has an API key
        const targetKeyInfo = await apiKeyManager.getKeyForUniversity(toEmail);
        if (targetKeyInfo.success) {
            return res.status(400).json({
                error: 'Target university already has an API key assigned'
            });
        }

        // Release key from source university
        const releaseResult = await apiKeyManager.releaseKey(fromEmail);
        if (!releaseResult.success) {
            return res.status(400).json(releaseResult);
        }

        // Assign the same key to target university
        const assignResult = await apiKeyManager.assignKey(toEmail, targetUniversity.universityId);

        if (assignResult.success) {
            res.json({
                message: 'API key reassigned successfully',
                fromUniversity: fromEmail,
                toUniversity: toEmail,
                keyId: assignResult.keyId
            });
        } else {
            // If assignment fails, try to reassign back to original
            await apiKeyManager.assignKey(fromEmail, 'recovery_' + Date.now());
            res.status(500).json({
                error: 'Failed to reassign API key',
                details: assignResult.error
            });
        }
    } catch (error) {
        console.error('Reassign API key error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API 9: Get system health and statistics
router.get('/system/health', async (req, res) => {
    try {
        // Get API key statistics
        const apiKeyStats = await apiKeyManager.getStats();

        // Count universities
        const universityFiles = await fs.readdir(UNIVERSITIES_DIR);
        const universityCount = universityFiles.filter(file => file.endsWith('.json')).length;

        // Count accounts
        const accountFiles = await fs.readdir(ACCOUNTS_DIR);
        const accountCount = accountFiles.filter(file => file.endsWith('.json')).length;

        // Calculate disk usage
        let totalSize = 0;

        // Calculate universities directory size
        for (const file of universityFiles) {
            if (file.endsWith('.json')) {
                const filePath = path.join(UNIVERSITIES_DIR, file);
                const stats = await fs.stat(filePath);
                totalSize += stats.size;
            }
        }

        // Calculate accounts directory size
        for (const file of accountFiles) {
            if (file.endsWith('.json')) {
                const filePath = path.join(ACCOUNTS_DIR, file);
                const stats = await fs.stat(filePath);
                totalSize += stats.size;
            }
        }

        // Convert to MB
        const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

        res.json({
            system: {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            },
            statistics: {
                universities: universityCount,
                accounts: accountCount,
                totalUsers: universityCount + accountCount,
                storageUsed: `${totalSizeMB} MB`
            },
            apiKeys: apiKeyStats
        });
    } catch (error) {
        console.error('System health check error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// API 10: Force deactivate/reactivate university (system admin only)
router.patch('/universities/:email/status', async (req, res) => {
    try {
        const { email } = req.params;
        const { isActive } = req.body;

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({
                error: 'isActive must be a boolean value'
            });
        }

        const university = await readUniversity(email);
        if (!university) {
            return res.status(404).json({ error: 'University not found' });
        }

        // Update status
        university.isActive = isActive;
        university.updatedAt = new Date().toISOString();

        // Save updated data
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const filePath = path.join(UNIVERSITIES_DIR, `${sanitizedEmail}.json`);
        await fs.writeFile(filePath, JSON.stringify(university, null, 2));

        // Also deactivate/reactivate all accounts of this university
        const accounts = await getUniversityAccounts(email);
        for (const account of accounts) {
            const accountData = await require('./universityadmin').readAccount(account.accountEmail);
            if (accountData) {
                accountData.isActive = isActive;
                accountData.updatedAt = new Date().toISOString();
                await require('./universityadmin').writeAccount(account.accountEmail, accountData);
            }
        }

        res.json({
            message: `University ${isActive ? 'activated' : 'deactivated'} successfully`,
            email: email,
            isActive: isActive,
            affectedAccounts: accounts.length
        });
    } catch (error) {
        console.error('Update university status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;