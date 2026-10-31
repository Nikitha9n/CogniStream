require("dotenv").config();
const express = require("express");
const path = require("path");
const MarkdownIt = require("markdown-it");
const Groq = require("groq-sdk");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session); // 👈 ADD THIS
const connection = require('./connection');
const bcrypt = require("bcryptjs");

//for input validation clean format
const { z } = require("zod");
const port = process.env.PORT || 3030;


const app = express();
const md = new MarkdownIt();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
// Required on Render so rate limiting and sessions identify real user IPs behind the proxy
app.set('trust proxy', 1);

// Set up view engine and views directory
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static files middleware
app.use(express.static(path.join(__dirname, "public")));

// Body parsing middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Required for handling fetch() JSON requests

// 2. Create the session store instance using your existing database connection
//user login session
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000, // Checks every 15 minutes to clear expired sessions
  expiration: 86400000,            // 24 hours in milliseconds
  createDatabaseTable: true        // Automatically creates a 'sessions' table in MySQL if it doesn't exist
}, connection); // 👈 Uses your existing MySQL connection object

// 3. Update your session middleware to use the store
app.use(
  session({
    store: sessionStore, // 👈 [ADDED] Tells Express to store sessions in MySQL instead of RAM
    secret: process.env.SESSION_SECRET || "my-secret-key",
    resave: false,
    saveUninitialized: false, // 👈 Changed to false so empty sessions don't clutter your database
    cookie: { 
  maxAge: 1000 * 60 * 60 * 24, // 24 hours
  httpOnly: true,
  secure: process.env.NODE_ENV === "production" // false locally, true on Render HTTPS
}
  })
);

// Groq API call helper with abort support
async function getGroqChatCompletion(qnn, abortSignal) {
  const completion = await groq.chat.completions.create(
    {
      model: "openai/gpt-oss-20b",
      max_tokens: 1000, // output length tokens limit
      stream: true,    // 👈 Enable token streaming
      messages: [
        { role: "system", content: "You are a helpful AI assistant. Answer clearly and concisely." },
        ...qnn,
      ],
    },
    { signal: abortSignal } // 👈 Pass the signal here so Groq can be cancelled
  );
  return completion; //full strean after completed return that answer 
  //to use outside the function
}

//sql connection code- in connection.js 
//rate limiting function
const rateLimit = require('express-rate-limit');

//send 5 request in 1 min  max
// min -2 reset -15 req
// min -3 reset -15req
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute 
  max: 5, // max 5 requests per windowMs
  message: { error: 'Too many requests. Please wait a few minutes before asking more questions.' },
  standardHeaders: true,
  legacyHeaders: false
});


//part -2
// 1. GET: Render chat form
app.get("/ask", async (req, res) => {
  // 1. Guard check: Must be logged in which user in current session loggien in 
  if (!req.session.userId) {
    return res.redirect("/user/login");
  }

  const userId = req.session.userId;
  const userName = req.session.userName;
  const convoId = req.query.convo_id ? parseInt(req.query.convo_id) : null;

  try {
    // 2. Fetch all previous conversations for this user (for sidebar/history navigation)
    const [conversations] = await connection.promise().query(
      "SELECT convo_id, title, updated_at FROM conversations WHERE uid = ? ORDER BY updated_at DESC",
      [userId]
    );

    let messages = [];

    // 3. If a specific convo_id was selected in the URL (e.g. /ask?convo_id=5), fetch its past messages
    if (convoId) {
      const [msgRows] = await connection.promise().query(
        "SELECT msg_id, role, content, created_at FROM messages WHERE convo_id = ? ORDER BY created_at ASC",
        [convoId]
      );
      
      // 👈 all messages while displaying makde then clean html format use render 
      //otherwise raw text is shown
      messages = msgRows.map((msg) => ({
        ...msg,
        contentHtml: md.render(msg.content || ""),
      }));
    }

    // 4. Render the page with user details, conversation list, and existing messages
    res.render("qnform", {
      userId: userId,
      userName: userName,
      conversations: conversations, // List of past chats for sidebar
      currentConvoId: convoId,      // Active conversation ID (or null for a new chat)
      pastMessages: messages        // Messages to render immediately on load
    });

  } catch (error) {
    console.error("Error loading chat page:", error);
    res.status(500).send("Unable to load chat interface.");
  }
});

// 🛡️ Zod schema contract for /ask requests
//checking input in same format only
const askSchema = z.object({
  qnsent: z
    .string({ required_error: "Question is required." })
    .trim()
    .min(1, "Please enter a valid question.")
    .max(1000, "Question is too long (max 1000 characters)."),
  level: z
    .enum(["beginner", "medium", "pro"], {
      errorMap: () => ({ message: "Invalid difficulty level selected." }),
    })
    .default("medium"),
});

// 2. POST: Process question & return JSON to chat.js
//every 1 min 15 req ,then next min reset
app.post("/ask", chatLimiter, async (req, res) => {
  // 1. Guard check,if userd id there in session
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please log in first." });
  }

  // ==========================================
  // 🛡️ INPUT VALIDATION / SANITIZATION BLOCK (ZOD)
  // ==========================================
  const validation = askSchema.safeParse(req.body);

  if (!validation.success) {
    // Safely get the message whether it's .issues or .errors
    const issue = validation.error.issues?.[0] || validation.error.errors?.[0];
    const message = issue ? issue.message : "Invalid input";
    
    return res.status(400).json({ error: message });
  }
  // Clean, validated, trimmed values directly from Zod
  const { qnsent: question, level } = validation.data;
  // ==========================================
  
  // 👈 [ADDED FOR 2-TABLE SCHEMA] Read convo_id from frontend (null if starting a brand new conversation)
  let convo_id = req.body.convo_id ? parseInt(req.body.convo_id) : null;

  // 👈 [ADDED] 1. Backend AbortController instance for this request
  const groqAbortController = new AbortController();

  // 👈 [ADDED] 2. Listen for client abort (user clicked Stop or 2-minute connection timeout hit)
  req.on("close", () => {
    if (!res.writableEnded) {
      console.log("Client disconnected or aborted. Halting Groq stream...");
      groqAbortController.abort(); // Cuts off the Groq request immediately
    }
  });
  // ==========================================

  try {
    if (!req.session.history) {
      req.session.history = [];
    }

    // ==========================================
    // 🧠 DYNAMIC PROMPT INSTRUCTION BY LEVEL
    // ==========================================
    let systemInstruction = "";
    if (level === "beginner") {
      systemInstruction = "You are an educator explaining concepts to a beginner. Use simple analogies, plain language, avoid confusing jargon, and keep explanations easy to grasp.";
    } else if (level === "pro") {
      systemInstruction = "You are an expert specialist. Provide a deep technical breakdown with comprehensive details, practical edge cases, architecture, and advanced concepts.";
    } else {
      // Medium: Clear & balanced (No forced developer persona)
      systemInstruction = "You are a helpful AI assistant. Provide a clear and balanced explanation that is well-structured, easy to follow, and thorough.";
    }

    // Build conversation transcript for multi-turn context
    //messages arrya at start empty 
    //1who is smriti 
    //her age 

    const conversationMessages = [];

    // 👉 RIGHT HERE: The difficulty level instruction is pushed first!
    conversationMessages.push({ role: "system", content: systemInstruction });

    // 👈 [ADDED FOR 2-TABLE SCHEMA] Step A: If new conversation, create thread in `conversations` table
    if (!convo_id) {
      const chatTitle = question.slice(0, 40); // Generate title from first question
      const [convResult] = await connection.promise().query(
        "INSERT INTO conversations (uid, title) VALUES (?, ?)",
        [req.session.userId, chatTitle]
      );
      convo_id = convResult.insertId; // Get the generated convo_id
    }

    // 👈 [ADDED FOR 2-TABLE SCHEMA] Step B: Fetch past messages from DB using convo_id for multi-turn memory
    const [pastRows] = await connection.promise().query(
      "SELECT role, content FROM messages WHERE convo_id = ? ORDER BY created_at ASC",
      [convo_id]
    );

    // Push past DB messages into conversation transcript
    pastRows.forEach((row) => {
      conversationMessages.push({ role: row.role, content: row.content });
    });

    // Finally, your current question is added at the end of converstaion messages
    conversationMessages.push({ role: "user", content: question });

    // 👈 [ADDED FOR 2-TABLE SCHEMA] Step C: Immediately save the user question to `messages` table
    await connection.promise().query(
      "INSERT INTO messages (convo_id, role, content) VALUES (?, 'user', ?)",
      [convo_id, question]
    );

    // ==========================================
    // ⚡ STREAMING SETUP: SERVER-SENT EVENTS (SSE) HEADERS
    // ==========================================
    // Instruct the browser to hold an open streaming connection
    //the anser coming in stream is stored in browser here (place 1)
    //so id ider ask fullow up qn no need to go to database ,
    //once full answer has come ans finished stored in database (place2)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders(); // Instantly establish the streaming channel
    }

    // 👈 [ADDED FOR 2-TABLE SCHEMA] Send active convo_id to browser so frontend knows the current chat ID
    res.write(`data: ${JSON.stringify({ convo_id: convo_id })}\n\n`);

    // Fetch response from Groq (using stream enabled in getGroqChatCompletion)
    // 👈 [ADDED] Passed groqAbortController.signal to helper
    let stream = await getGroqChatCompletion(conversationMessages, groqAbortController.signal);
    let rawAnswer = "";
    let hitTokenLimit = false; // 👈 [ADDED FOR 2-TABLE SCHEMA] Flag to detect token cap

    // 🌊 Iterate over incoming token chunks from Groq as they arrive
    for await (const chunk of stream) {
      // 👈 [ADDED] Stop processing immediately if client aborted mid-stream
      if (groqAbortController.signal.aborted) 
        break;

      //data is coming in chunks  from grok,
      //first  display each chunk in browser as it arrives
      //add each chunk to array as it arrives 
      const token = chunk.choices[0]?.delta?.content || "";
      const finishReason = chunk.choices[0]?.finish_reason; // 👈 [ADDED FOR 2-TABLE SCHEMA] Check finish reason

      if (token) {
        rawAnswer += token; //append chunks in array temporary
        //write to browser the chunks using write function
        res.write(`data: ${JSON.stringify({ token: token })}\n\n`);
      }

      // 👈 [ADDED FOR 2-TABLE SCHEMA] If output stopped because max_tokens was reached
      if (finishReason === "length") {
        hitTokenLimit = true;
      }
    }

    // Guard: Do not save aborted or blank answers
    if (groqAbortController.signal.aborted) {
      return res.end();
    }

    // 👈 If rawAnswer is blank (token limit reached during thinking), notify the browser!
    if (!rawAnswer || rawAnswer.trim() === "") {
      res.write(`data: ${JSON.stringify({ token: "⚠️ Token limit reached before an answer could be generated. Please increase max_tokens." })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      return res.end();
    }

    // 👈 [ADDED FOR 2-TABLE SCHEMA] If token limit hit, append clean continuation notice
    if (hitTokenLimit) {
      const continuationNotice = "\n\n⚠️ **Token limit reached.**\n*Do you want me to generate more? Reply with **'continue'** to proceed.*";
      rawAnswer += continuationNotice;
      res.write(`data: ${JSON.stringify({ token: continuationNotice })}\n\n`);
    }

    //convert tio html format from raw text
    const answerHtml = md.render(rawAnswer);

    //1.now data(question -1) add to session once every all chunks has arrived 
    //before that dont add in session
    req.session.history.push({
      question: question,
      rawAnswer: rawAnswer,
      answerHtml: answerHtml,
      time: new Date().toLocaleTimeString(),
    });

    // 2. Second: Force Node.js to finish writing the session to memory
    //all data of question 1 save in the session 
    req.session.save((err) => {
      if (err) console.error("Session save error:", err);

      // 3. Third: nw tell the node js that streaming is complete ,next we need to add to db so
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end(); // Browser unlocks the submit button only AFTER the session is secured
      //response of qn 1 is over close that session
    });

    // --- INSERT INTO MYSQL DATABASE ---
    // 👈 [ADDED FOR 2-TABLE SCHEMA] Insert AI response into `messages` table under convo_id
    let q = "INSERT INTO messages (convo_id, role, content) VALUES (?, 'assistant', ?)";
    connection.query(q, [convo_id, rawAnswer], (error, result) => {
      if (error) {
        console.error("Database insert error into messages:", error);
      } else {
        console.log("Saved AI answer to messages table for convo_id:", convo_id);
      }
      // Note: res.json is omitted here because res.end() already closed the streaming HTTP response above
    });

  } catch (error) {
    // 👈 [ADDED] Check if error is due to intentional abort
    if (error.name === "AbortError" || groqAbortController.signal.aborted) {
      console.log("Groq generation stopped on client abort.");
      return;
    }

    console.error("Groq API Error:", error);
    // If an error happens during the stream, write the error event so the client displays it cleanly
    if (!res.headersSent) {
      //error that happens before streaming begins //spi key wrong,server down of grok
      res.status(500).json({ error: "Something went wrong fetching the answer." });
    } else {
      //error that happens in the middle of the stream
      res.write(`data: ${JSON.stringify({ error: "Something went wrong fetching the answer." })}\n\n`);
      res.end();
    }
  }
});

//part-3
// 3. GET: View history from chattable
app.get("/history", async (req, res) => {
  // Guard check
  if (!req.session.userId) {
    return res.redirect("/user/login");
  }

  const userId = req.session.userId;

  try {
    // 1. Fetch conversations for this user
    const [convRows] = await connection.promise().query(
      `SELECT convo_id, title, 
              COALESCE(is_important, 0) AS is_important, 
              DATE_FORMAT(updated_at, '%h:%i:%s %p') AS time 
       FROM conversations 
       WHERE uid = ? 
       ORDER BY convo_id DESC`,
      [userId]
    );

    // 2. Fetch messages for each conversation
    const history = [];

    for (const conv of convRows) {
      const [messages] = await connection.promise().query(
        `SELECT msg_id, role, content, 
                DATE_FORMAT(created_at, '%h:%i:%s %p') AS time 
         FROM messages 
         WHERE convo_id = ? 
         ORDER BY msg_id ASC`,
        [conv.convo_id]
      );

      const isImportant = conv.is_important === 1 || conv.is_important === true || conv.is_important === '1';

      const parsedMessages = messages.map(msg => ({
        ...msg,
        contentHtml: md.render(msg.content || "")
      }));

      history.push({
        convo_id: conv.convo_id,
        title: conv.title,
        time: conv.time,
        is_important: isImportant,
        messages: parsedMessages
      });
    }

    // 3. Render page
    res.render("history", {
      conversations: history,
      history: history,
      userId: userId,
      userName: req.session.userName
    });

  } catch (error) {
    console.error("🔥 Detailed History Error:", error.message);
    res.status(500).send(`Database error: ${error.message}`);
  }
});

// 4. POST: Clear all history from MySQL
// POST: Clear all chat history for current user
app.post("/clear-all-history", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/user/login");
  }

  const userId = req.session.userId;

  try {
    // 1. Delete all messages belonging to the user's conversations
    await connection.promise().query(
      `DELETE m FROM messages m
       INNER JOIN conversations c ON m.convo_id = c.convo_id
       WHERE c.uid = ?`,
      [userId]
    );

    // 2. Delete all conversation rows for the user
    await connection.promise().query(
      `DELETE FROM conversations WHERE uid = ?`,
      [userId]
    );

    res.redirect("/history");
  } catch (error) {
    console.error("Error clearing chat history:", error.message);
    res.status(500).send(`Server error: ${error.message}`);
  }
});

// 6. POST route to toggle star/important status (message importnat and not importnat)
app.post(["/toggle-star/:id", "/toggle-important/:id"], (req, res) => {
  // 1. Guard check: make sure the user is logged in
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }

  const convoId = parseInt(req.params.id, 10);
  const currentUid = req.session.userId;

  // 2. Flip the is_important bit on the conversations table for this user
  const sql = `
    UPDATE conversations 
    SET is_important = NOT COALESCE(is_important, 0) 
    WHERE convo_id = ? AND uid = ?
  `;

  connection.query(sql, [convoId, currentUid], (err, result) => {
    if (err) {
      console.error("SQL Error in toggle-star:", err);
      return res.status(500).json({ error: "Failed to update star in database" });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Conversation not found or unauthorized." });
    }

    // 3. Query the updated value to return it back to the client UI
    connection.query(
      "SELECT is_important FROM conversations WHERE convo_id = ? AND uid = ?",
      [convoId, currentUid],
      (fetchErr, rows) => {
        if (fetchErr || rows.length === 0) {
          return res.json({ success: true });
        }
        const updatedStatus = rows[0].is_important === 1 || rows[0].is_important === true;
        return res.json({ success: true, is_important: updatedStatus });
      }
    );
  });
});
// ----------------------------LOGIN and register---------------------------------------
app.get("/user/register", (req, res) => {
  res.render("register.ejs", { msg: req.query.msg || null });
});

app.get("/user/login", (req, res) => {
  res.render("login.ejs", { msg: req.query.msg || null });
});

app.post("/user/register/", async (req, res) => {
  let { gusername, gemail, gpassword } = req.body;

  try {
    // 1. Hash the plain text password using bcrypt with 10 salt rounds
    // This converts the plain password (e.g., '123') into a secure 60-character hash
    const hashedPassword = await bcrypt.hash(gpassword, 10);

    // 2. Query remains the same, but we insert the hashed password instead of plain text
    let q = "insert into grokuser(name,email,password) values(?,?,?)";

    // Pass hashedPassword into the query array instead of gpassword
    connection.query(q, [gusername, gemail, hashedPassword], (error, result) => {
      if (error) {
        // [FIX] Log error and prevent unhandled crash if email already exists (duplicate key error)
        console.error("Database registration error:", error);
        return res.redirect("/user/register?msg=error");
      }

      // Redirect to login page and pass the message flag
      res.redirect("/user/login?msg=registered");
    });
  } catch (err) {
    console.error("Hashing error:", err);
    // [FIX] Send user a clean redirect instead of throwing an unhandled exception
    res.redirect("/user/register?msg=error");
  }
});

app.post("/user/login", (req, res) => {
  let { gemail, gpassword } = req.body;
  console.log(gemail, gpassword);

  //extract email ,passwors is 123 and hashed will be 60 chars so cant compare
  let q = "SELECT * FROM grokuser WHERE email=?";

  connection.query(q, [gemail], async (error, result) => {
    if (error) {
      console.error("Database query error:", error);
      return res.redirect("/user/login?msg=error");
    }

    console.log(result);

    // [FIX CRITICAL] Added 'return' keyword here!
    // Without 'return', JavaScript continues executing the lines below even if no user was found.
    // 'return' stops the function immediately and redirects without attempting to read result[0].password.
    if (!result || result.length === 0) {
      // Redirect back to login with error flag
      return res.redirect("/user/login?msg=invalid");
    } 

    // [FIX] Wrapped bcrypt in try/catch to safely handle edge cases (e.g., null password or invalid hash strings)
    try {
      // 2. Here is where the password is checked!
      // bcrypt compares what the user typed (gpassword) against the hash stored in MySQL (result[0].password)
      const isMatch = await bcrypt.compare(gpassword, result[0].password);

      if (!isMatch) {
        // Wrong password -> reject login
        return res.redirect("/user/login?msg=invalid");
      }

      //1st request un email correct means save his id 
      ///everytime he send request ,in this session cookie created
      // Save logged-in user details to the active session
      req.session.userId = result[0].uid;
      req.session.userName = result[0].name;

      console.log("Session saved for UID:", req.session.userId);
      res.redirect("/ask");

    } catch (bcryptErr) {
      console.error("Password comparison error:", bcryptErr);
      return res.redirect("/user/login?msg=invalid");
    }
  });
});



// 🗑️ Delete a single message turn inside a conversation

app.post("/delete-message/:msg_id", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const msgId = parseInt(req.params.msg_id, 10);
  const currentUid = req.session.userId;

  const q = `
    DELETE m 
    FROM messages m
    JOIN conversations c ON m.convo_id = c.convo_id
    WHERE m.msg_id = ? AND c.uid = ?
  `;

  connection.query(q, [msgId, currentUid], (error, result) => {
    if (error) {
      console.error("Error deleting individual message:", error);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Return JSON if requested via client fetch
    if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
      return res.json({ success: true, deletedMsgId: msgId });
    }

    res.redirect(req.get("Referrer") || "/history");
  });
});


// DELETE ENTIRE CONVERSATION THREAD
app.post("/delete-convo/:convo_id", async (req, res) => {
  // 1. Guard check: make sure user is logged in
  if (!req.session || !req.session.userId) {
    return res.redirect("/user/login");
  }

  const convoId = parseInt(req.params.convo_id, 10);
  const currentUid = req.session.userId;

  try {
    // 2. Delete all child messages belonging to this conversation
    // (Protects data integrity if ON DELETE CASCADE is not set in MySQL)
    await connection.promise().query(
      `DELETE m FROM messages m
       JOIN conversations c ON m.convo_id = c.convo_id
       WHERE m.convo_id = ? AND c.uid = ?`,
      [convoId, currentUid]
    );

    // 3. Delete the parent conversation entry for this user
    const [result] = await connection.promise().query(
      `DELETE FROM conversations 
       WHERE convo_id = ? AND uid = ?`,
      [convoId, currentUid]
    );

    if (result.affectedRows === 0) {
      console.warn(`Conversation #${convoId} not found or unauthorized for user #${currentUid}`);
    }

    // 4. Redirect back to the History page cleanly
    return res.redirect("/history");
  } catch (err) {
    console.error("Error deleting conversation:", err);
    return res.status(500).send("Database error while deleting conversation.");
  }
});


// EXPORT CONVERSATION (supports format=txt | md | json)
app.get("/export-convo/:convo_id", async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).send("Unauthorized. Please log in.");
  }

  const convoId = parseInt(req.params.convo_id, 10);
  const currentUid = req.session.userId;
  const format = (req.query.format || "txt").toLowerCase();

  try {
    // 1. Verify conversation belongs to user
    const [convRows] = await connection.promise().query(
      `SELECT title, created_at FROM conversations WHERE convo_id = ? AND uid = ?`,
      [convoId, currentUid]
    );

    if (convRows.length === 0) {
      return res.status(404).send("Conversation not found.");
    }

    const conv = convRows[0];
    const safeTitle = (conv.title || "conversation").replace(/[^a-zA-Z0-9_-]/g, "_");

    // 2. Fetch all messages in sequence
    const [messages] = await connection.promise().query(
      `SELECT role, content, created_at FROM messages WHERE convo_id = ? ORDER BY msg_id ASC`,
      [convoId]
    );

    // 3. Generate file content based on format
    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_${convoId}.json"`);
      return res.send(JSON.stringify({ title: conv.title, convo_id: convoId, messages }, null, 2));
    }

    if (format === "md") {
      let mdText = `# ${conv.title || "Conversation"}\n\n`;
      mdText += `*Exported on: ${new Date().toLocaleString()}*\n\n---\n\n`;
      messages.forEach((m) => {
        const sender = m.role === "user" ? "### 👤 You" : "### 🤖 AI";
        mdText += `${sender}\n\n${m.content}\n\n---\n\n`;
      });

      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_${convoId}.md"`);
      return res.send(mdText);
    }

    // Default: Plain Text (.txt)
    let txtOutput = `Conversation: ${conv.title || "Untitled"}\nDate: ${new Date().toLocaleString()}\n`;
    txtOutput += `========================================================\n\n`;
    messages.forEach((m) => {
      const sender = m.role === "user" ? "YOU" : "AI";
      txtOutput += `[${sender}]:\n${m.content}\n\n--------------------------------------------------------\n\n`;
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_${convoId}.txt"`);
    return res.send(txtOutput);

  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).send("Database error during export.");
  }
});


app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}/ask`);
});































































































