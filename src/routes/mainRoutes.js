const express = require('express');

const mainController = require('../controllers/mainController');

const router = express.Router();

router.post('/analyze_users_portfolio', mainController.analyzeUsersPortfolio);
router.post('/ai-simple-fix', mainController.getAiSimpleFix);

module.exports = router;