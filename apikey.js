const fs = require('fs').promises;
const path = require('path');

// Database paths
const DB_DIR = path.join(__dirname, 'database');
const API_KEYS_FILE = path.join(DB_DIR, 'api_keys.json');

/**
 * API Key Manager
 * Manages assignment of Gemini API keys to universities
 * Ensures no two universities get the same API key
 */
class APIKeyManager {
    constructor() {
        this.apiKeys = [
            {
                key: 'AIzaSyB1fSKYe32_I4ztlFmjgese0LWDWV4KNsY',
                id: 'key_1',
                assignedTo: null,
                assignedAt: null,
                isAvailable: true
            },
            {
                key: 'AIzaSyC2xP9mN4vL7bQ6tY8wR5eD3cF1hG9jK2n',
                id: 'key_2',
                assignedTo: null,
                assignedAt: null,
                isAvailable: true
            },
            {
                key: 'AIzaSyD4yT8nL6vP3xQ9wR7eC5bF2hG1jK4mN6p',
                id: 'key_3',
                assignedTo: null,
                assignedAt: null,
                isAvailable: true
            },
            {
                key: 'AIzaSyE6zN9mP7xT4yQ2wR8eD6cF3hG5jK7nL9b',
                id: 'key_4',
                assignedTo: null,
                assignedAt: null,
                isAvailable: true
            },
            {
                key: 'AIzaSyF8bT3nQ9xP6yL5wR4eC7dF2hG8jK1mN4v',
                id: 'key_5',
                assignedTo: null,
                assignedAt: null,
                isAvailable: true
            }
        ];
        this.initializeDatabase();
    }

    /**
     * Initialize database file with default API keys
     */
    async initializeDatabase() {
        try {
            await fs.mkdir(DB_DIR, { recursive: true });

            // Check if file exists
            try {
                await fs.access(API_KEYS_FILE);
                // File exists, load existing data
                await this.loadKeys();
            } catch {
                // File doesn't exist, create with default keys
                await this.saveKeys();
                console.log('API Keys database initialized with default keys');
            }
        } catch (error) {
            console.error('Error initializing API keys database:', error);
        }
    }

    /**
     * Load API keys from file
     */
    async loadKeys() {
        try {
            const data = await fs.readFile(API_KEYS_FILE, 'utf8');
            this.apiKeys = JSON.parse(data);
        } catch (error) {
            console.error('Error loading API keys:', error);
            // Keep default keys if loading fails
        }
    }

    /**
     * Save API keys to file
     */
    async saveKeys() {
        try {
            await fs.writeFile(API_KEYS_FILE, JSON.stringify(this.apiKeys, null, 2));
        } catch (error) {
            console.error('Error saving API keys:', error);
            throw error;
        }
    }

    /**
     * Get an available API key for a new university
     * @param {string} universityEmail - Email of the university
     * @param {string} universityId - ID of the university
     * @returns {Promise<Object>} Object containing key info or error
     */
    async assignKey(universityEmail, universityId) {
        try {
            await this.loadKeys();

            // Check if university already has a key assigned
            const existingKey = this.apiKeys.find(k => k.assignedTo === universityEmail);
            if (existingKey) {
                return {
                    success: true,
                    key: existingKey.key,
                    keyId: existingKey.id,
                    message: 'Using existing assigned key'
                };
            }

            // Find first available key
            const availableKey = this.apiKeys.find(k => k.isAvailable === true);

            if (!availableKey) {
                return {
                    success: false,
                    error: 'No API keys available. All keys are currently assigned.'
                };
            }

            // Assign the key
            availableKey.assignedTo = universityEmail;
            availableKey.assignedAt = new Date().toISOString();
            availableKey.isAvailable = false;
            availableKey.universityId = universityId;

            await this.saveKeys();

            return {
                success: true,
                key: availableKey.key,
                keyId: availableKey.id,
                assignedAt: availableKey.assignedAt
            };
        } catch (error) {
            console.error('Error assigning API key:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Release an API key back to the pool
     * @param {string} universityEmail - Email of the university
     * @returns {Promise<Object>} Success status
     */
    async releaseKey(universityEmail) {
        try {
            await this.loadKeys();

            const keyToRelease = this.apiKeys.find(k => k.assignedTo === universityEmail);

            if (!keyToRelease) {
                return {
                    success: false,
                    error: 'No key found for this university'
                };
            }

            // Release the key
            keyToRelease.assignedTo = null;
            keyToRelease.assignedAt = null;
            keyToRelease.isAvailable = true;
            keyToRelease.universityId = null;

            await this.saveKeys();

            return {
                success: true,
                message: `API key ${keyToRelease.id} released successfully`
            };
        } catch (error) {
            console.error('Error releasing API key:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get the API key assigned to a university
     * @param {string} universityEmail - Email of the university
     * @returns {Promise<Object>} Key info or null
     */
    async getKeyForUniversity(universityEmail) {
        try {
            await this.loadKeys();

            const assignedKey = this.apiKeys.find(k => k.assignedTo === universityEmail);

            if (!assignedKey) {
                return {
                    success: false,
                    error: 'No key assigned to this university'
                };
            }

            return {
                success: true,
                key: assignedKey.key,
                keyId: assignedKey.id,
                assignedAt: assignedKey.assignedAt
            };
        } catch (error) {
            console.error('Error getting API key:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get statistics about API key usage
     * @returns {Promise<Object>} Statistics object
     */
    async getStats() {
        try {
            await this.loadKeys();

            const totalKeys = this.apiKeys.length;
            const assignedKeys = this.apiKeys.filter(k => !k.isAvailable).length;
            const availableKeys = this.apiKeys.filter(k => k.isAvailable).length;

            return {
                success: true,
                stats: {
                    total: totalKeys,
                    assigned: assignedKeys,
                    available: availableKeys,
                    keys: this.apiKeys.map(k => ({
                        id: k.id,
                        assignedTo: k.assignedTo,
                        assignedAt: k.assignedAt,
                        isAvailable: k.isAvailable
                    }))
                }
            };
        } catch (error) {
            console.error('Error getting stats:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Check if there are available keys
     * @returns {Promise<boolean>} True if keys are available
     */
    async hasAvailableKeys() {
        try {
            await this.loadKeys();
            return this.apiKeys.some(k => k.isAvailable === true);
        } catch (error) {
            console.error('Error checking available keys:', error);
            return false;
        }
    }

    /**
     * Get all API keys with their status (admin only)
     * @returns {Promise<Array>} Array of API key objects
     */
    async getAllKeys() {
        try {
            await this.loadKeys();
            return {
                success: true,
                keys: this.apiKeys.map(k => ({
                    id: k.id,
                    keyPreview: `${k.key.substring(0, 15)}...${k.key.substring(k.key.length - 4)}`,
                    assignedTo: k.assignedTo,
                    universityId: k.universityId,
                    assignedAt: k.assignedAt,
                    isAvailable: k.isAvailable
                }))
            };
        } catch (error) {
            console.error('Error getting all keys:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Add a new API key to the pool
     * @param {string} newKey - The new API key to add
     * @returns {Promise<Object>} Success status
     */
    async addKey(newKey) {
        try {
            await this.loadKeys();

            // Check if key already exists
            const exists = this.apiKeys.some(k => k.key === newKey);
            if (exists) {
                return {
                    success: false,
                    error: 'This API key already exists in the pool'
                };
            }

            const newKeyId = `key_${this.apiKeys.length + 1}`;
            this.apiKeys.push({
                key: newKey,
                id: newKeyId,
                assignedTo: null,
                assignedAt: null,
                isAvailable: true
            });

            await this.saveKeys();

            return {
                success: true,
                message: `API key ${newKeyId} added successfully`,
                keyId: newKeyId
            };
        } catch (error) {
            console.error('Error adding API key:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Remove an API key from the pool (only if not assigned)
     * @param {string} keyId - ID of the key to remove
     * @returns {Promise<Object>} Success status
     */
    async removeKey(keyId) {
        try {
            await this.loadKeys();

            const keyIndex = this.apiKeys.findIndex(k => k.id === keyId);

            if (keyIndex === -1) {
                return {
                    success: false,
                    error: 'API key not found'
                };
            }

            const key = this.apiKeys[keyIndex];

            if (!key.isAvailable) {
                return {
                    success: false,
                    error: 'Cannot remove an assigned API key. Release it first.'
                };
            }

            this.apiKeys.splice(keyIndex, 1);
            await this.saveKeys();

            return {
                success: true,
                message: `API key ${keyId} removed successfully`
            };
        } catch (error) {
            console.error('Error removing API key:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export singleton instance
module.exports = new APIKeyManager();