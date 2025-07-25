// controllers/authController.js
const authService = require('../services/authService');
const logger = require('../logger');

exports.register = async (req, res) => {
  try {
    const response = await authService.registerUser(req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
    logger.error(`Register Controller Error: ${err.message}`);
    res.status(500).json({ error: 'Server error during registration' });
  }
};

exports.login = async (req, res) => {
  try {
    const response = await authService.loginUser(req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
    logger.error(`Login Controller Error: ${err.message}`);
    res.status(500).json({ error: 'Server error during login' });
  }
};

exports.loginWithGoogle = async (req, res) => {
  try {
    const { id_token } = req.body; // from frontend Google sign-in
    if (!id_token) return res.status(400).json({ error: 'Missing Google id_token' });
    const result = await authService.loginWithGoogle(id_token);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.error(`Google Login Controller Error: ${err.message}`);
    res.status(500).json({ error: 'Server error during Google login' });
  }
};
