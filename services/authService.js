//authService.js

require('dotenv').config();
const pool = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');
const { OAuth2Client } = require('google-auth-library');

const { schema, tables } = config.db;
// Initialize Google OAuth2 client
const client = new OAuth2Client(process.env.CLIENT_ID);

// Centralized table and column names
const LOGIN_TABLE = `"${schema}"."${tables.login}"`;
const USER_PROFILE_TABLE = `"${schema}"."${tables.userProfile}"`;

const LOGIN_COLUMNS = {
  USERNAME: 'USERNAME',
  PASSWORD: 'PASSWORD',
  USER_TYPE: 'USER_TYPE',
  IS_ACTIVE: 'IS_ACTIVE',
  USER_ID: 'USER_ID',
};

const PROFILE_COLUMNS = {
  USER_ID: 'USER_ID',
  FULL_NAME: 'FULL_NAME',
  PHONE_NUMBER: 'PHONE_NUMBER',
  EMAIL: 'EMAIL',
  ADDRESS: 'ADDRESS',
  GENDER: 'GENDER',
  PROFILE_IMAGE: 'PROFILE_IMAGE',
};

const USER_TYPES = {
  ADMIN: '0',
  OWNER: '1',
  TENANT: '2',
  AGENT: '3',
};

// Add constants for boolean values as strings
const ACTIVE_STATUS = {
  ACTIVE: '1',
  INACTIVE: '0'
};

const ERROR_CODES = {
  MISSING_FIELDS: 'ERR001',
  USER_EXISTS: 'ERR002',
  USER_NOT_FOUND: 'ERR003',
  WRONG_PASSWORD: 'ERR004',
  DATABASE_ERROR: 'ERR005',
  JWT_ERROR: 'ERR006',
};

// Gender conversion function to handle varchar(1) constraint
const convertGender = (gender) => {
  if (!gender) return null;
  
  const genderStr = gender.toString().toLowerCase();
  if (genderStr === 'male' || genderStr === 'm' || genderStr === '0') {
    return 'M';
  } else if (genderStr === 'female' || genderStr === 'f' || genderStr === '1') {
    return 'F';
  }
  
  // Return first character as fallback, or null if invalid
  return gender.length > 0 ? gender.charAt(0).toUpperCase() : null;
};

// Register new user
exports.registerUser = async (data) => {
  const { full_name, gender, email, password } = data;

  if (!full_name || !gender || !email || !password) {
    logger.warn('Missing required fields on registration');
    return {
      status: 400,
      data: {
        error: 'Missing required fields',
        code: ERROR_CODES.MISSING_FIELDS,
      },
    };
  }

  const dbClient = await pool.connect(); // Get a client from the pool
  try {
    await dbClient.query('BEGIN'); // Start transaction

    const userCheckQuery = `
      SELECT p."${PROFILE_COLUMNS.EMAIL}"
      FROM ${LOGIN_TABLE} u
      LEFT JOIN ${USER_PROFILE_TABLE} p 
        ON u."${LOGIN_COLUMNS.USER_ID}" = p."${PROFILE_COLUMNS.USER_ID}"
      WHERE p."${PROFILE_COLUMNS.EMAIL}" = $1
    `;
    const existingUser = await dbClient.query(userCheckQuery, [email]);

    if (existingUser.rows.length > 0) {
      await dbClient.query('ROLLBACK');
      logger.info(`Duplicate registration attempt for email: ${email}`);
      return {
        status: 400,
        data: {
          error: 'Email already exists',
          code: ERROR_CODES.USER_EXISTS,
        },
      };
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const insertLoginUserQuery = `
      INSERT INTO ${LOGIN_TABLE} 
      ("${LOGIN_COLUMNS.USERNAME}", "${LOGIN_COLUMNS.PASSWORD}", "${LOGIN_COLUMNS.USER_TYPE}", "${LOGIN_COLUMNS.IS_ACTIVE}")
      VALUES ($1, $2, $3, $4) RETURNING "${LOGIN_COLUMNS.USER_ID}"
    `;
    const userRes = await dbClient.query(insertLoginUserQuery, [
      email,
      hashedPassword,
      USER_TYPES.TENANT,
      ACTIVE_STATUS.ACTIVE, // Changed from true to '1'
    ]);

    const userId = userRes.rows[0][LOGIN_COLUMNS.USER_ID];

    // Ensure that userId is correctly fetched and not null
    if (!userId) {
      logger.error('User ID not returned from login insert');
      await dbClient.query('ROLLBACK');
      return {
        status: 500,
        data: {
          error: 'Failed to register user',
          code: ERROR_CODES.DATABASE_ERROR,
        },
      };
    }

    // Convert gender to single character
    const convertedGender = convertGender(gender);
    
    // Log for debugging
    logger.info(`Converting gender: "${gender}" -> "${convertedGender}"`);

    const insertProfileQuery = `
      INSERT INTO ${USER_PROFILE_TABLE} 
      ("${PROFILE_COLUMNS.USER_ID}", "${PROFILE_COLUMNS.FULL_NAME}", "${PROFILE_COLUMNS.PHONE_NUMBER}", 
       "${PROFILE_COLUMNS.EMAIL}", "${PROFILE_COLUMNS.ADDRESS}", "${PROFILE_COLUMNS.GENDER}", "${PROFILE_COLUMNS.PROFILE_IMAGE}")
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await dbClient.query(insertProfileQuery, [
      userId,
      full_name,
      null,
      email,
      null,
      convertedGender, // Use converted gender
      null,
    ]);
    
    await dbClient.query('COMMIT'); // Commit the transaction if both queries succeed

    logger.info(`User registered with email: ${email}`);
    return { status: 201, data: { message: 'User registered successfully' } };
  } catch (error) {
    await dbClient.query('ROLLBACK'); // Rollback in case of any error
    logger.error('Database error during registration:', {
      message: error.message,
      stack: error.stack,
      data: { full_name, gender, email: email ? 'provided' : 'missing' }
    });
    return {
      status: 500,
      data: { error: 'Database error', code: ERROR_CODES.DATABASE_ERROR },
    };
  } finally {
    dbClient.release(); // Always release the client back to the pool
  }
};

// Login user
exports.loginUser = async (data) => {
  const expiresIn = process.env.JWT_EXPIRATION;
  const { email, password } = data;

  if (!email || !password) {
    logger.warn('Login failed: email or password is missing');
    return {
      status: 400,
      data: { error: 'Email and password are required', code: ERROR_CODES.MISSING_FIELDS },
    };
  }

  try {
    const query = `
      SELECT * FROM ${LOGIN_TABLE} 
      WHERE "${LOGIN_COLUMNS.IS_ACTIVE}" = $1 AND "${LOGIN_COLUMNS.USERNAME}" = $2
    `;
    const result = await pool.query(query, [ACTIVE_STATUS.ACTIVE, email]); // Changed from true to '1'
    const user = result.rows[0];

    if (!user) {
      logger.warn(`Login failed for non-existing user: ${email}`);
      return {
        status: 401,
        data: { error: 'Invalid email or password', code: ERROR_CODES.USER_NOT_FOUND },
      };
    }

    const isMatch = await bcrypt.compare(password, user[LOGIN_COLUMNS.PASSWORD]);
    if (!isMatch) {
      logger.warn(`Login failed: wrong password for user ${email}`);
      return {
        status: 401,
        data: { error: 'Invalid email or password', code: ERROR_CODES.WRONG_PASSWORD },
      };
    }

    const token = jwt.sign({ userId: user[LOGIN_COLUMNS.USER_ID] }, process.env.JWT_SECRET, { expiresIn });

    logger.info(`User logged in: ${email}`);
    return { status: 200, data: { message: 'Login successful', token } };
  } catch (error) {
    logger.error('Database error during login:', {
      message: error.message,
      stack: error.stack,
    });
    return {
      status: 500,
      data: { error: 'Database error', code: ERROR_CODES.DATABASE_ERROR },
    };
  }
};

// Get profile
exports.getUserProfile = async (userId) => {
  const query = `
    SELECT 
      p."${PROFILE_COLUMNS.FULL_NAME}", 
      p."${PROFILE_COLUMNS.PHONE_NUMBER}", 
      p."${PROFILE_COLUMNS.EMAIL}",
      p."${PROFILE_COLUMNS.ADDRESS}", 
      p."${PROFILE_COLUMNS.GENDER}", 
      p."${PROFILE_COLUMNS.PROFILE_IMAGE}",
      l."${LOGIN_COLUMNS.USER_TYPE}"
    FROM ${USER_PROFILE_TABLE} p
    JOIN ${LOGIN_TABLE} l ON p."${PROFILE_COLUMNS.USER_ID}" = l."${LOGIN_COLUMNS.USER_ID}"
    WHERE p."${PROFILE_COLUMNS.USER_ID}" = $1
  `;
  try {
    const result = await pool.query(query, [userId]);
    if (result.rows.length === 0) {
      return { status: 404, data: { error: 'User profile not found' } };
    }
    return { status: 200, data: { profile: result.rows[0] } };
  } catch (error) {
    logger.error('Error fetching user profile:', {
      message: error.message,
      stack: error.stack,
    });
    return { status: 500, data: { error: 'Database error' } };
  }
};

exports.loginWithGoogle = async (id_token) => {
  const dbClient = await pool.connect();
  try {
    // 1. Verify the Google id_token
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload.email_verified) {
      return { status: 403, data: { error: 'Email not verified by Google.' } };
    }

    const email = payload.email;
    const full_name = payload.name || "";
    const picture = payload.picture || null;
    const gender = convertGender(payload.gender); // Convert gender here

    // Start transaction
    await dbClient.query('BEGIN');

    // 2. Check if user exists
    const userCheckRes = await dbClient.query(
      `SELECT u."${LOGIN_COLUMNS.USER_ID}", u."${LOGIN_COLUMNS.USER_TYPE}"
         FROM ${LOGIN_TABLE} u
         LEFT JOIN ${USER_PROFILE_TABLE} p ON u."${LOGIN_COLUMNS.USER_ID}" = p."${PROFILE_COLUMNS.USER_ID}"
         WHERE p."${PROFILE_COLUMNS.EMAIL}" = $1`,
      [email]
    );
    
    let userId, userType;
    
    if (userCheckRes.rows.length === 0) {
      // 3. If not exists, create new login and profile
      const insertLoginRes = await dbClient.query(
        `INSERT INTO ${LOGIN_TABLE} ("${LOGIN_COLUMNS.USERNAME}", "${LOGIN_COLUMNS.PASSWORD}", "${LOGIN_COLUMNS.USER_TYPE}", "${LOGIN_COLUMNS.IS_ACTIVE}")
         VALUES ($1, $2, $3, $4) RETURNING "${LOGIN_COLUMNS.USER_ID}", "${LOGIN_COLUMNS.USER_TYPE}"`,
        [email, null, USER_TYPES.TENANT, ACTIVE_STATUS.ACTIVE] // Changed from true to '1'
      );
      
      userId = insertLoginRes.rows[0][LOGIN_COLUMNS.USER_ID];
      userType = insertLoginRes.rows[0][LOGIN_COLUMNS.USER_TYPE];
      
      await dbClient.query(
        `INSERT INTO ${USER_PROFILE_TABLE} ("${PROFILE_COLUMNS.USER_ID}", "${PROFILE_COLUMNS.FULL_NAME}", "${PROFILE_COLUMNS.PHONE_NUMBER}", "${PROFILE_COLUMNS.EMAIL}", "${PROFILE_COLUMNS.ADDRESS}", "${PROFILE_COLUMNS.GENDER}", "${PROFILE_COLUMNS.PROFILE_IMAGE}")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, full_name, null, email, null, gender, picture] // gender is already converted
      );
    } else {
      userId = userCheckRes.rows[0][LOGIN_COLUMNS.USER_ID];
      userType = userCheckRes.rows[0][LOGIN_COLUMNS.USER_TYPE];
    }

    // Commit
    await dbClient.query('COMMIT');

    // 4. Issue JWT as usual
    const token = jwt.sign(
      { userId, user_type: userType, email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || "12h" }
    );

    logger.info(`User logged in with Google: ${email}`);
    return { status: 200, data: { message: "Google login successful", token } };
  } catch (err) {
    // Rollback
    try { 
      await dbClient.query('ROLLBACK'); 
    } catch (e) { 
      logger.error('ROLLBACK failed', e); 
    }
    logger.error(`Google Auth error: ${err.message}`);
    return {
      status: 400,
      data: { error: 'Google authentication failed.' }
    };
  } finally {
    dbClient.release();
  }
};
