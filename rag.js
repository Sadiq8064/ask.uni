const axios = require('axios');

const RAG_API_BASE_URL = 'https://gfapi-production-84ad.up.railway.app';

/**
 * RAG Service for Gemini File Search API Integration
 */
class RAGService {
    constructor() {
        this.baseURL = RAG_API_BASE_URL;
    }

    /**
     * Create a new store in Gemini File Search
     * @param {string} apiKey - Gemini API key
     * @param {string} storeName - Name of the store to create
     * @returns {Promise<Object>} Store creation response
     */
    async createStore(apiKey, storeName) {
        try {
            const response = await axios.post(`${this.baseURL}/stores/create`, {
                api_key: apiKey,
                store_name: storeName
            });
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Error creating store:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    /**
     * Upload files to a specific store
     * @param {string} apiKey - Gemini API key
     * @param {string} storeName - Name of the store
     * @param {Array} files - Array of file buffers or paths
     * @param {boolean} limit - Whether to enforce file size limit (default: true)
     * @returns {Promise<Object>} Upload response
     */
    async uploadFiles(apiKey, storeName, files, limit = true) {
        try {
            const FormData = require('form-data');
            const formData = new FormData();

            formData.append('api_key', apiKey);
            formData.append('limit', limit.toString());

            // Add files to form data
            for (const file of files) {
                if (file.buffer && file.originalname) {
                    formData.append('files', file.buffer, file.originalname);
                } else if (file.path && file.filename) {
                    const fs = require('fs');
                    formData.append('files', fs.createReadStream(file.path), file.filename);
                }
            }

            const response = await axios.post(
                `${this.baseURL}/stores/${storeName}/upload`,
                formData,
                {
                    headers: formData.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );

            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Error uploading files:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    /**
     * List all stores
     * @param {string} apiKey - Gemini API key
     * @returns {Promise<Object>} List of stores
     */
    async listStores(apiKey) {
        try {
            const response = await axios.get(`${this.baseURL}/stores`, {
                params: { api_key: apiKey }
            });
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Error listing stores:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    /**
     * Delete a document from a store
     * @param {string} apiKey - Gemini API key
     * @param {string} storeName - Name of the store
     * @param {string} documentId - Document ID to delete
     * @returns {Promise<Object>} Deletion response
     */
    async deleteDocument(apiKey, storeName, documentId) {
        try {
            const response = await axios.delete(
                `${this.baseURL}/stores/${storeName}/documents/${documentId}`,
                {
                    params: { api_key: apiKey }
                }
            );
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Error deleting document:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    /**
     * Delete an entire store
     * @param {string} apiKey - Gemini API key
     * @param {string} storeName - Name of the store to delete
     * @returns {Promise<Object>} Deletion response
     */
    async deleteStore(apiKey, storeName) {
        try {
            const response = await axios.delete(
                `${this.baseURL}/stores/${storeName}`,
                {
                    params: { api_key: apiKey }
                }
            );
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Error deleting store:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    /**
     * Ask a question using RAG (Retrieval Augmented Generation)
     * @param {string} apiKey - Gemini API key
     * @param {Array<string>} stores - Array of store names to query
     * @param {string} question - Question to ask
     * @param {string} systemPrompt - Optional system prompt
     * @returns {Promise<Object>} Answer response
     */
    async askQuestion(apiKey, stores, question, systemPrompt = null) {
        try {
            const response = await axios.post(`${this.baseURL}/ask`, {
                api_key: apiKey,
                stores: stores,
                question: question,
                system_prompt: systemPrompt
            });
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            console.error('Error asking question:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error || error.message
            };
        }
    }

    /**
     * Check if a store exists
     * @param {string} apiKey - Gemini API key
     * @param {string} storeName - Name of the store to check
     * @returns {Promise<boolean>} True if store exists
     */
    async storeExists(apiKey, storeName) {
        try {
            const result = await this.listStores(apiKey);
            if (result.success && result.data.stores) {
                return result.data.stores.some(store => store.store_name === storeName);
            }
            return false;
        } catch (error) {
            console.error('Error checking store existence:', error);
            return false;
        }
    }

    /**
     * Create a unique store name for a university
     * @param {string} universityName - Name of the university
     * @returns {string} Sanitized store name
     */
    generateStoreName(universityName) {
        // Remove special characters and convert to lowercase
        let storeName = universityName
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .trim();

        // Add timestamp suffix to ensure uniqueness
        const timestamp = Date.now();
        storeName = `${storeName}_${timestamp}`;

        // Limit length
        if (storeName.length > 100) {
            storeName = storeName.substring(0, 100);
        }

        return storeName;
    }

    /**
     * Initialize store for a university during registration
     * @param {string} apiKey - Gemini API key
     * @param {string} universityName - Name of the university
     * @param {string} universityEmail - Email of the university (for uniqueness)
     * @returns {Promise<Object>} Store creation result
     */
    async initializeUniversityStore(apiKey, universityName, universityEmail) {
        try {
            // Generate a unique store name based on university name
            const baseStoreName = universityName
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .replace(/\s+/g, '_')
                .replace(/_+/g, '_')
                .trim();

            // Use email domain as additional uniqueness factor
            const emailDomain = universityEmail.split('@')[1].split('.')[0];
            const storeName = `${baseStoreName}_${emailDomain}`;

            // Check if store already exists
            const exists = await this.storeExists(apiKey, storeName);
            if (exists) {
                // If exists, append timestamp
                const uniqueStoreName = `${storeName}_${Date.now()}`;
                const result = await this.createStore(apiKey, uniqueStoreName);
                return result;
            }

            // Create the store
            const result = await this.createStore(apiKey, storeName);
            return result;

        } catch (error) {
            console.error('Error initializing university store:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get store statistics
     * @param {string} apiKey - Gemini API key
     * @param {string} storeName - Name of the store
     * @returns {Promise<Object>} Store statistics
     */
    async getStoreStats(apiKey, storeName) {
        try {
            const result = await this.listStores(apiKey);
            if (result.success && result.data.stores) {
                const store = result.data.stores.find(s => s.store_name === storeName);
                if (store) {
                    return {
                        success: true,
                        stats: {
                            storeName: store.store_name,
                            fileCount: store.files ? store.files.length : 0,
                            createdAt: store.created_at,
                            files: store.files || []
                        }
                    };
                }
            }
            return {
                success: false,
                error: 'Store not found'
            };
        } catch (error) {
            console.error('Error getting store stats:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export singleton instance
module.exports = new RAGService();