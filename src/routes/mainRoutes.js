const express = require('express');

const mainController = require('../controllers/mainController');

const router = express.Router();

router.post('/analyze_users_portfolio', mainController.analyzeUsersPortfolio);
router.post('/ai-simple-fix', mainController.getAiSimpleFix);
router.post('/realtime-price', mainController.getRealtimePrice);

module.exports = router;