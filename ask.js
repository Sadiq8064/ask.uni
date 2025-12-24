// ask.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs").promises;
const RAGService = require("./rag");
const { GoogleGenerativeAI } = require("@google/generative-ai"); // keep as before

// DB paths
const DB_DIR = path.join(__dirname, "database");
const STUDENTS_DIR = path.join(DB_DIR, "students");
const UNIVERSITIES_DIR = path.join(DB_DIR, "universities");
const CHAT_DIR = path.join(DB_DIR, "chat_sessions");
const PROVIDER_LOGS_DIR = path.join(DB_DIR, "provider_questions");

// ensure directories
(async () => {
    await fs.mkdir(CHAT_DIR, { recursive: true });
    await fs.mkdir(PROVIDER_LOGS_DIR, { recursive: true });
})();

// -------------------- helpers --------------------
async function readStudent(email) {
    try {
        const safe = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
        const file = path.join(STUDENTS_DIR, safe + ".json");
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return null;
    }
}

async function readUniversity(email) {
    try {
        const safe = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
        const file = path.join(UNIVERSITIES_DIR, safe + ".json");
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return null;
    }
}

function getSessionFile(email, sessionId) {
    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
    return path.join(CHAT_DIR, `${safeEmail}__${sessionId}.json`);
}

function generateSessionName(question) {
    if (!question || typeof question !== "string") return "New Session";
    const words = question.trim().split(/\s+/);
    return words.length <= 10 ? question.trim() : words.slice(0, 10).join(" ") + "...";
}

// Append message to session file (async)
async function appendMessageToSessionFile(email, sessionId, messageObj) {
    const file = getSessionFile(email, sessionId);
    try {
        let session = JSON.parse(await fs.readFile(file, "utf8"));
        session.messages = session.messages || [];
        session.messages.push(messageObj);
        session.updatedAt = new Date().toISOString();
        await fs.writeFile(file, JSON.stringify(session, null, 2));
    } catch (err) {
        // if session file missing, create one
        const sessionData = {
            sessionId,
            sessionName: generateSessionName(messageObj.question || ""),
            email,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [messageObj]
        };
        await fs.writeFile(file, JSON.stringify(sessionData, null, 2));
    }
}

// Create session file (called synchronously before responding if new)
async function createSessionFile(email, sessionId, sessionName) {
    const file = getSessionFile(email, sessionId);
    const sessionData = {
        sessionId,
        sessionName,
        email,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
    };
    await fs.writeFile(file, JSON.stringify(sessionData, null, 2));
}

// Provider logs (store which provider/store was asked + question + answer + timestamp)
async function appendProviderLog(providerEmail, logDoc) {
    try {
        const safe = providerEmail.replace(/[^a-zA-Z0-9@._-]/g, "_");
        const file = path.join(PROVIDER_LOGS_DIR, `${safe}.json`);
        let arr = [];
        try {
            arr = JSON.parse(await fs.readFile(file, "utf8"));
            if (!Array.isArray(arr)) arr = [];
        } catch {
            arr = [];
        }
        arr.push(logDoc);
        await fs.writeFile(file, JSON.stringify(arr, null, 2));
    } catch (err) {
        console.error("appendProviderLog error:", err);
    }
}

// ---------------- GEMINI CLASSIFIER (improved system prompt) ----------------
async function classifyStores(geminiKey, stores, question) {
    try {
        if (!geminiKey) {
            // fallback: return all stores with no splitting
            return { stores: stores, split_questions: {}, unanswered: [] };
        }

        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // TIGHT system prompt — explicit JSON only, deterministic, temperature 0
        const SYSTEM_PROMPT = `
You are a strict classifier and splitter. INPUT:
- stores list (names only): ${JSON.stringify(stores)}
- user's question (provided as the user content)

TASK:
1) Decide which of the stores from the list can answer whole or parts of the user's question.
2) If some part belongs to a store, rewrite that part clearly and put it in split_questions under that store name.
3) If a part belongs to multiple stores, include it under all relevant store keys.
4) If a part cannot be answered by any store, include that part in "unanswered" with a short "reason".

OUTPUT REQUIREMENTS (must output only valid JSON, nothing else):
{
  "stores": ["store1","store2"],               // exact store names from the provided list (or empty array)
  "split_questions": {                         // mapping store -> rewritten question part
     "store1": "rewritten part for store1",
     "store2": "rewritten part for store2"
  },
  "unanswered": [                              // list of {text, reason}
     { "text": "original part text", "reason": "why no store can answer" }
  ]
}

If NO store can answer, return:
{
  "stores": [],
  "split_questions": {},
  "unanswered": [{ "text": "<full question>", "reason": "No department can answer this" }]
}

Do NOT return any extra text, commentary, or explanation. Return valid JSON only.
`.trim();

        const result = await model.generateContent({
            contents: question,
            system_instruction: SYSTEM_PROMPT,
            generationConfig: { temperature: 0.0 }
        });

        // extract text safely
        const txt = result.response?.text?.() || (result.candidates && result.candidates[0] && result.candidates[0].text) || "";
        if (!txt) return { stores: [], split_questions: {}, unanswered: [] };

        // Parse JSON — try direct parse, otherwise extract substring
        const raw = txt.trim();
        try {
            return JSON.parse(raw);
        } catch (e) {
            const start = raw.indexOf("{");
            const end = raw.lastIndexOf("}");
            if (start !== -1 && end !== -1) {
                try {
                    return JSON.parse(raw.slice(start, end + 1));
                } catch (e2) {
                    console.warn("classifyStores: JSON parse failed after substring");
                }
            }
        }

        // if parse fails, fallback: treat all stores as selected without splitting
        return { stores: stores, split_questions: {}, unanswered: [] };
    } catch (err) {
        console.error("classifyStores error:", err);
        return { stores: stores, split_questions: {}, unanswered: [] };
    }
}

// ---------------- POST /ask ----------------
// Behavior: respond asap, then do all storage/logging asynchronously
router.post("/ask", async (req, res) => {
    try {
        const { email, question } = req.body;
        let { sessionId } = req.body;

        if (!email || !question) {
            return res.status(400).json({ error: "email & question required" });
        }

        const student = await readStudent(email);
        if (!student) return res.status(404).json({ error: "Student not found" });

        const accessible = student.accessibleStores || [];
        const storeNames = accessible.map(s => s.storeName);

        if (storeNames.length === 0) {
            // no stores — quick response (nothing to log)
            return res.json({
                sessionId: null,
                answer: "No RAG stores available for your account.",
                storesUsed: [],
                grounding: []
            });
        }

        // get university key (use university-provided key)
        const university = await readUniversity(student.universityEmail).catch(() => null);
        const geminiKey = university?.apiKeyInfo?.key || null;

        // if new session create id + name synchronously (we will persist file async AFTER sending response)
        let isNewSession = false;
        if (!sessionId) {
            isNewSession = true;
            sessionId = "session_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        }
        const sessionName = isNewSession ? generateSessionName(question) : undefined;

        // 1) classify (Gemini) — blocking call (we need store selection before asking RAG)
        const classification = await classifyStores(geminiKey, storeNames, question);
        const predictedStores = classification.stores || [];
        const splitQuestions = classification.split_questions || {};
        const unanswered = classification.unanswered || [];

        // If Gemini explicitly says no store
        if (!predictedStores || predictedStores.length === 0) {
            // Prepare immediate response
            const answerText = "Sorry, none of the departments can answer this.";

            // Respond quickly
            res.json({
                sessionId,
                answer: answerText,
                storesUsed: [],
                unanswered
            });

            // Fire-and-forget: record session + message asynchronously
            (async () => {
                try {
                    // create session file if new
                    if (isNewSession) await createSessionFile(email, sessionId, sessionName);

                    const messageObj = {
                        role: "assistant",
                        question,
                        answer: answerText,
                        storesUsed: [],
                        grounding: [],
                        timestamp: new Date().toISOString(),
                        unresolvedParts: unanswered
                    };
                    await appendMessageToSessionFile(email, sessionId, messageObj);
                } catch (err) {
                    console.error("background log error (no stores):", err);
                }
            })();

            return; // done
        }

        // 2) For each predicted store -> call RAG (we must wait for RAG answers before responding)
        // We will call RAG sequentially to control load, but you can make it parallel if desired.
        const ragResults = [];
        const allGrounding = [];

        for (const store of predictedStores) {
            const qForStore = (splitQuestions && splitQuestions[store]) ? splitQuestions[store] : question;
            // Use the university gemini key as RAG API key as required by your system
            // RAGService.askQuestion(apiKey, storesArray, question)
            const ragResp = await RAGService.askQuestion(geminiKey, [store], qForStore);

            if (!ragResp || !ragResp.success || !ragResp.data) {
                // RAG failed or empty for this store -> immediate minimal response and async log
                const dept = accessible.find(x => x.storeName === store);
                const answerText = "Sorry we didn't find any information related to this.";

                // Respond quickly
                res.json({
                    sessionId,
                    answer: answerText,
                    searchedIn: dept?.accountEmail || null
                });

                // Fire-and-forget: log what we attempted
                (async () => {
                    try {
                        if (isNewSession) await createSessionFile(email, sessionId, sessionName);

                        const messageObj = {
                            role: "assistant",
                            question,
                            answer: answerText,
                            storesUsed: [store],
                            grounding: [],
                            timestamp: new Date().toISOString(),
                            searchedIn: dept?.accountEmail || null
                        };
                        await appendMessageToSessionFile(email, sessionId, messageObj);

                        // provider log
                        if (dept?.accountEmail) {
                            await appendProviderLog(dept.accountEmail, {
                                provider_email: dept.accountEmail,
                                user_email: email,
                                store_name: store,
                                question: qForStore,
                                response: null,
                                asked_at: new Date().toISOString()
                            });
                        }
                    } catch (err) {
                        console.error("background log error (rag failed):", err);
                    }
                })();

                return; // done
            }

            // successful rag result expected shape in ragResp.data
            const answerText = ragResp.data.response_text || "";
            const groundingChunks = ragResp.data.grounding_metadata?.groundingChunks || [];
            ragResults.push({ store, answerText, groundingChunks });

            // collect grounding texts for return and storage
            for (const chunk of groundingChunks || []) {
                const ctx = chunk.retrievedContext || {};
                if (ctx.text) allGrounding.push(ctx.text);
            }
        }

        // 3) Merge results (if multiple)
        let finalAnswer;
        if (ragResults.length === 1) {
            finalAnswer = ragResults[0].answerText;
        } else {
            finalAnswer = ragResults.map(r => `**${r.store}**:\n${r.answerText}`).join("\n\n");
        }

        // 4) Respond IMMEDIATELY with the final answer
        res.json({
            sessionId,
            answer: finalAnswer,
            storesUsed: predictedStores,
            grounding: allGrounding
        });

        // 5) FIRE-AND-FORGET: persist session + messages + provider logs asynchronously
        (async () => {
            try {
                // create session if new
                if (isNewSession) await createSessionFile(email, sessionId, sessionName);

                // Save assistant message
                const messageObj = {
                    role: "assistant",
                    question,
                    answer: finalAnswer,
                    storesUsed: predictedStores,
                    grounding: allGrounding,
                    timestamp: new Date().toISOString()
                };
                await appendMessageToSessionFile(email, sessionId, messageObj);

                // Save provider-specific logs for each store: include which department email owns store
                for (const r of ragResults) {
                    const store = r.store;
                    const dept = accessible.find(x => x.storeName === store);
                    const providerEmail = dept?.accountEmail || null;
                    const qForStore = (splitQuestions && splitQuestions[store]) ? splitQuestions[store] : question;

                    await appendProviderLog(providerEmail || "unknown", {
                        provider_email: providerEmail,
                        user_email: email,
                        store_name: store,
                        question: qForStore,
                        response: r.answerText,
                        grounding: r.groundingChunks || [],
                        asked_at: new Date().toISOString()
                    });
                }
            } catch (err) {
                console.error("background persistence error:", err);
            }
        })();

    } catch (err) {
        console.error("ASK endpoint error:", err);
        // If we haven't sent a response yet, return error now
        if (!res.headersSent) {
            return res.status(500).json({ error: "Internal Server Error" });
        }
        // otherwise just log
    }
});

// ------------------------- GET ALL SESSIONS (sessionId + sessionName) -------------------------
router.get("/sessions/:email", async (req, res) => {
    try {
        const { email } = req.params;
        const safePrefix = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
        const files = await fs.readdir(CHAT_DIR);
        const sessions = [];
        for (const file of files) {
            if (file.startsWith(safePrefix + "__")) {
                try {
                    const data = JSON.parse(await fs.readFile(path.join(CHAT_DIR, file), "utf8"));
                    sessions.push({ sessionId: data.sessionId, sessionName: data.sessionName, createdAt: data.createdAt });
                } catch { /* skip invalid */ }
            }
        }
        // sort newest first
        sessions.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ sessions });
    } catch (err) {
        console.error("sessions list err:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ----------------------- GET SPECIFIC SESSION (full structured data) -----------------------
router.get("/session/:email/:sessionId", async (req, res) => {
    try {
        const { email, sessionId } = req.params;
        const file = getSessionFile(email, sessionId);
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        res.json(data);
    } catch (err) {
        res.status(404).json({ error: "Session not found" });
    }
});

module.exports = router;
