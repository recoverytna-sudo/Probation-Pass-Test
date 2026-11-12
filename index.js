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

// Fetch questions directly from Google Sheet 'Multiple Choose' tab
async function fetchQuestionsFromSheet() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: PROCESS_SHEET_ID,
      range: "'Multiple Choose'!A:G",
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) {
      throw new Error("Google Sheet 'Multiple Choose' Tab ထဲတွင် မေးခွန်းများ မရှိသေးပါ။");
    }

    const dataRows = rows.slice(1);

    let allQuestions = dataRows.map((row, idx) => {
      const questionText = row[1] || '';
      const options = [row[2], row[3], row[4], row[5]].filter(opt => opt !== undefined && opt !== '' && opt !== null);
      
      let correctAnsRaw = parseInt(row[6]) - 1;
      if (isNaN(correctAnsRaw) || correctAnsRaw < 0 || correctAnsRaw >= options.length) {
        correctAnsRaw = 0;
      }

      return {
        id: idx + 1,
        question: questionText,
        options: options,
        answer: correctAnsRaw
      };
    }).filter(q => q.question && q.options.length > 0);

    shuffleArray(allQuestions);
    const selectedQuestions = allQuestions.slice(0, 60);

    return selectedQuestions.map((q, index) => ({
      ...q,
      no: index + 1
    }));
  } catch (err) {
    console.error("Error fetching questions from Sheet:", err.message);
    throw new Error("Google Sheet မှ မေးခွန်းများ ဖတ်ယူရာတွင် အမှားအယွင်းရှိနေပါသည်။");
  }
}

app.get('/api/questions', async (req, res) => {
  try {
    const questions = await fetchQuestionsFromSheet();
    global.cachedQuestions = questions;

    const sanitized = questions.map((q) => ({
      no: q.no,
      id: q.id,
      question: q.question,
      options: q.options
    }));

    res.json({ success: true, questions: sanitized });
  } catch (err) {
    console.error("Questions API Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Also support GET root or health check
app.get('/', (req, res) => {
  res.send('Odoo Probation Exam Backend is running successfully!');
});

async function createAndUploadPDF(fileName, title, contentData) {
  const doc = new PDFDocument();
  let buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  
  doc.fontSize(18).text(title, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Date & Time: ${new Date().toLocaleString()}`);
  doc.moveDown();

  for (let key in contentData) {
    doc.text(`${key}: ${contentData[key]}`);
  }
  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('end', async () => {
      try {
        let pdfBuffer = Buffer.concat(buffers);
        const uploadUrl = `${WEBDAV_BASE_URL}/${fileName}`.replace(/([^:]\/)\/+/g, "$1");

        await axios.put(uploadUrl, pdfBuffer, {
          auth: { username: WEBDAV_USER, password: WEBDAV_PASS },
          headers: { 'Content-Type': 'application/pdf' }
        });

        const downloadLink = `${WEBDAV_PUBLIC_VIEW_URL}/${fileName}`;
        resolve(downloadLink);
      } catch (error) {
        console.error("WebDAV Upload Error:", error.response?.data || error.message);
        reject(error);
      }
    });
  });
}

// Universal handler for submitting exam (covers all possible Odoo frontend route variants)
async function handleExamSubmission(req, res) {
  try {
    const { employeeName, employeeId, managerName, answers } = req.body;
    const questions = global.cachedQuestions || [];

    let score = 0;
    questions.forEach(q => {
      if (answers && answers[q.id] !== undefined && answers[q.id] === q.answer) {
        score += 1;
      }
    });

    const subId = 'SUB-' + Date.now();
    const pdfData = {
      'Submission ID': subId,
      'Employee Name': employeeName,
      'Employee ID': employeeId,
      'Manager Name': managerName,
      'Exam Score': `${score} / ${questions.length || 60}`,
      'Status': 'Pending Manager Feedback'
    };

    const pdfUrl = await createAndUploadPDF(`${subId}_Exam.pdf`, 'Probation Exam Result', pdfData);

    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: DATABASE_SHEET_ID,
      range: "'Exam_Records'!A:M",
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[subId, employeeName, employeeId, managerName, score, pdfUrl, 'Pending', '', '', '', '', '', new Date().toISOString()]]
      }
    });

    res.json({ success: true, submissionId: subId, score, pdfUrl });
  } catch (err) {
    console.error("Submit Exam Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// Register all potential endpoint paths used by Odoo frontend
app.post('/api/submit-exam', handleExamSubmission);
app.post('/api/submit', handleExamSubmission);
app.post('/api/exam/submit', handleExamSubmission);
app.post('/submit-exam', handleExamSubmission);
app.post('/submit', handleExamSubmission);

app.post('/api/dashboard', async (req, res) => {
  const { password } = req.body;
  if (password !== '1366') {
    return res.status(401).json({ success: false, message: 'စကားဝှက် (Password) မှားယွင်းနေပါသည်။' });
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DATABASE_SHEET_ID,
      range: "'Exam_Records'!A:M",
    });
    const rows = response.data.values || [];
    const data = rows.slice(1).map((row, idx) => ({
      rowIndex: idx + 2,
      submissionId: row[0] || '',
      employeeName: row[1] || '',
      employeeId: row[2] || '',
      managerName: row[3] || '',
      examScore: row[4] || '0',
      examPdf: row[5] || '',
      status: row[6] || 'Pending',
      feedbackRating: row[7] || '',
      feedbackScore: row[8] || '',
      totalScore: row[9] || '',
      finalRating: row[10] || '',
      finalPdf: row[11] || '',
      timestamp: row[12] || ''
    }));

    res.json({ success: true, records: data });
  } catch (err) {
    console.error("Dashboard Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/submit-feedback', async (req, res) => {
  const { password, submissionId, rating } = req.body;
  if (password !== '1366') {
    return res.status(401).json({ success: false, message: 'စကားဝှက် (Password) မှားယွင်းနေပါသည်။' });
  }

  const ratingMap = { 0: 0, 1: 20, 2: 40, 3: 60, 4: 80, 5: 100 };
  const feedbackScore = ratingMap[rating] !== undefined ? ratingMap[rating] : 0;

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DATABASE_SHEET_ID,
      range: "'Exam_Records'!A:M",
    });
    const rows = response.data.values || [];
    let rowIndex = -1;
    let examScore = 0;
    let empName = '', empId = '', mgrName = '';

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === submissionId) {
        rowIndex = i + 1;
        empName = rows[i][1];
        empId = rows[i][2];
        mgrName = rows[i][3];
        examScore = parseFloat(rows[i][4]) || 0;
        break;
      }
    }

    if (rowIndex === -1) return res.status(404).json({ success: false, message: 'Record not found' });

    const totalScore = examScore + feedbackScore;
    let finalRatingDesc = '';
    if (totalScore < 80) finalRatingDesc = 'Rating 1 (Exam Fail)';
    else if (totalScore < 90) finalRatingDesc = 'Rating 2 (Exam Fail)';
    else if (totalScore <= 120) finalRatingDesc = 'Rating 3 (Pass)';
    else if (totalScore <= 140) finalRatingDesc = 'Rating 4 (Pass)';
    else finalRatingDesc = 'Rating 5 (Pass)';

    const finalPdfData = {
      'Submission ID': submissionId,
      'Employee Name': empName,
      'Employee ID': empId,
      'Manager Name': mgrName,
      'Exam Score': `${examScore} Marks`,
      'Feedback Rating': `Rating ${rating} (${feedbackScore} Marks)`,
      'Total Score': `${totalScore} Marks`,
      'Final Evaluation Result': finalRatingDesc,
      'Status': 'Completed'
    };

    const finalPdfUrl = await createAndUploadPDF(`${submissionId}_Final.pdf`, 'Probation Final Result Report', finalPdfData);

    await sheets.spreadsheets.values.update({
      spreadsheetId: DATABASE_SHEET_ID,
      range: `'Exam_Records'!G${rowIndex}:L${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [['Completed', `Rating ${rating}`, feedbackScore, totalScore, finalRatingDesc, finalPdfUrl]]
      }
    });

    res.json({ success: true, totalScore, finalRatingDesc, finalPdfUrl });
  } catch (err) {
    console.error("Feedback Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
