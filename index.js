const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { google } = require('googleapis');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const tempKeyPath = path.join('/tmp', 'sa-key.json');
try {
  let saJsonString = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
  if (saJsonString.startsWith('"') && saJsonString.endsWith('"')) {
    saJsonString = saJsonString.slice(1, -1);
  }
  fs.writeFileSync(tempKeyPath, saJsonString);
} catch (err) {
  console.error("Error writing service account JSON to /tmp:", err);
}

const auth = new google.auth.GoogleAuth({
  keyFile: tempKeyPath,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const PROCESS_SHEET_ID = process.env.PROCESS_GOOGLE_SHEET_ID;
const DATABASE_SHEET_ID = process.env.DATABASE_GOOGLE_SHEET_ID;

const WEBDAV_BASE_URL = process.env.WEBDAV_BASE_URL;
const WEBDAV_USER = process.env.WEBDAV_USER;
const WEBDAV_PASS = process.env.WEBDAV_PASS;
const WEBDAV_PUBLIC_VIEW_URL = process.env.WEBDAV_PUBLIC_VIEW_URL;

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

global.examSessions = global.examSessions || {};

async function fetchQuestionsFromSheet() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: PROCESS_SHEET_ID,
      range: "'Multiple Choose'!A:G",
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) {
      throw new Error("Google Sheet 'Multiple Choose' Tab ထဲတွင် မေးခွန်းများ မရှိပါ။");
    }

    const dataRows = rows.slice(1);
    let allQuestions = [];

    dataRows.forEach((row, idx) => {
      // row[1] is Question text (Column B)
      if (!row[1] || String(row[1]).trim() === "") return;

      // Options are in Column C, D, E, F (Indices 2, 3, 4, 5)
      const options = [row[2], row[3], row[4], row[5]].filter(opt => opt !== undefined && opt !== null && String(opt).trim() !== "");
      
      // Correct Answer is in Column G (Index 6)
      let correctAnsRaw = String(row[6] || '1').trim();

      allQuestions.push({
        id: idx + 1,
        no: row[0] || (idx + 1),
        question: String(row[1]).trim(),
        options: options,
        correctAnswer: correctAnsRaw
      });
    });

    if (allQuestions.length === 0) {
      throw new Error("No valid questions parsed from sheet range.");
    }

    shuffleArray(allQuestions);
    return allQuestions.slice(0, 40); // ၄၀ လုံး Random ဆွဲထုတ်မည်
  } catch (err) {
    console.error("Sheet Fetch Error:", err.message);
    throw new Error(err.message);
  }
}

app.get('/api/questions', async (req, res) => {
  try {
    const questions = await fetchQuestionsFromSheet();
    const sessionKey = "exam_session_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    
    global.examSessions[sessionKey] = questions;

    const clientQuestions = questions.map((q, index) => ({
      index: index + 1,
      originalId: q.id,
      no: q.no,
      question: q.question,
      options: q.options
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      status: "success",
      sessionKey: sessionKey,
      questions: clientQuestions
    });
  } catch (err) {
    console.error("Questions API Error:", err.message);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Odoo Probation Exam Backend is running successfully!');
});

// PDF & Submit Handlers
async function createAndUploadPDF(subId, userInfo, score, total, percentage, passStatus, detailedResults) {
  const doc = new PDFDocument({ margin: 40 });
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  
  doc.fontSize(18).text('Finance Ops Probation Exam Result Report', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Submission ID: ${subId}`, { align: 'center' });
  doc.moveDown();

  doc.fontSize(10);
  doc.text(`Date: ${userInfo.date}`);
  doc.text(`Finance Name: ${userInfo.name}`);
  doc.text(`Employee ID: ${userInfo.id}`);
  doc.text(`Score: ${score} / ${total} (${percentage}%) - Status: ${passStatus}`);
  doc.moveDown();

  detailedResults.forEach((d, idx) => {
    doc.fontSize(9).fillColor(d.isCorrect ? '#008000' : '#FF0000');
    doc.text(`${idx + 1}. Q: ${d.question}`);
    doc.text(`   - Your Answer: ${d.userAnswer} | Correct Answer: ${d.correctAnswerText}`);
    doc.moveDown(0.2);
  });

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', async () => {
      try {
        let pdfBuffer = Buffer.concat(buffers);
        const safeName = userInfo.name.replace(/[^a-zA-Z0-9]/g, '_') || 'Employee';
        const safeId = userInfo.id.replace(/[^a-zA-Z0-9]/g, '_') || 'ID';
        const fileName = `${safeName}_${safeId}_${subId}_Exam_Result.pdf`;

        const uploadUrl = `${WEBDAV_BASE_URL}/${fileName}`.replace(/([^:]\/)\/+/g, "$1");

        await axios.put(uploadUrl, pdfBuffer, {
          auth: { username: WEBDAV_USER, password: WEBDAV_PASS },
          headers: { 'Content-Type': 'application/pdf' }
        });

        const downloadLink = `${WEBDAV_PUBLIC_VIEW_URL}/${fileName}`;
        resolve({ pdfBuffer, downloadLink, fileName });
      } catch (error) {
        console.error("WebDAV Upload Warning:", error.message);
        resolve({ pdfBuffer: Buffer.from([]), downloadLink: "", fileName: `${subId}_Exam_Result.pdf` });
      }
    });
  });
}

global.pdfBufferStore = global.pdfBufferStore || {};

async function handleExamSubmission(req, res) {
  try {
    const { employeeName, employeeId, managerName, answers, sessionKey } = req.body;
    
    let questions = sessionKey ? global.examSessions[sessionKey] : null;
    if (!questions) {
      questions = await fetchQuestionsFromSheet();
    }

    let score = 0;
    let totalQuestions = questions.length;
    let detailedResults = [];

    questions.forEach((q, i) => {
      const userAns = answers && (answers[q.id] !== undefined ? answers[q.id] : answers[String(q.id)]);
      const correctAns = String(q.correctAnswer).trim();
      
      let isCorrect = false;
      if (userAns !== undefined && userAns !== null && userAns !== "") {
        const userAnsStr = String(userAns).trim();
        if (userAnsStr === correctAns) {
          isCorrect = true;
        } else {
          const correctIdx = parseInt(correctAns);
          if (!isNaN(correctIdx) && correctIdx >= 1 && correctIdx <= q.options.length) {
            const correctOptionText = String(q.options[correctIdx - 1]).trim();
            if (userAnsStr === correctOptionText) {
              isCorrect = true;
            }
          }
        }
      }
      
      if (isCorrect) score++;

      let correctText = "";
      const correctIndexNum = parseInt(correctAns);
      if (!isNaN(correctIndexNum) && correctIndexNum >= 1 && correctIndexNum <= q.options.length) {
        correctText = q.options[correctIndexNum - 1];
      } else {
        correctText = correctAns;
      }

      detailedResults.push({
        questionNo: i + 1,
        question: q.question,
        options: q.options,
        userAnswer: (userAns !== undefined && userAns !== "") ? userAns : "မဖြေရသေးပါ",
        correctAnswerText: correctText,
        isCorrect: isCorrect
      });
    });

    const percentage = ((score / totalQuestions) * 100).toFixed(2);
    const passStatus = percentage >= 60 ? "Pass (အောင်မြင်သည်)" : "Fail (ကျရှုံးသည်)";
    const subId = 'SUB-' + Date.now();

    const userInfo = {
      name: employeeName || "Unknown",
      id: employeeId || "Unknown",
      manager: managerName || "Unknown",
      date: new Date().toLocaleDateString()
    };

    const { pdfBuffer, downloadLink } = await createAndUploadPDF(
      subId, userInfo, score, totalQuestions, percentage, passStatus, detailedResults
    );

    global.pdfBufferStore[subId] = pdfBuffer;

    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: DATABASE_SHEET_ID,
      range: "'Exam_Records'!A:M",
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[subId, userInfo.name, userInfo.id, userInfo.manager, score, downloadLink || 'No PDF', 'Pending', '', '', '', '', '', new Date().toISOString()]]
      }
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      status: "success",
      submissionId: subId,
      score: score,
      total: totalQuestions,
      percentage: percentage,
      passStatus: passStatus,
      pdfUrl: downloadLink,
      detailedResults: detailedResults
    });
  } catch (err) {
    console.error("Submit Exam Error:", err.message);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(500).json({ status: "error", message: err.message });
  }
}

app.get('/api/download-pdf/:subId', (req, res) => {
  const { subId } = req.params;
  const buffer = global.pdfBufferStore[subId];
  if (!buffer) {
    return res.status(404).send('PDF file not found or expired.');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${subId}_Exam_Result.pdf`);
  res.send(buffer);
});

app.post('/api/submit-exam', handleExamSubmission);
app.post('/api/submit', handleExamSubmission);
app.post('/submit-exam', handleExamSubmission);
app.post('/submit', handleExamSubmission);

app.post('*', (req, res) => {
  return handleExamSubmission(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
