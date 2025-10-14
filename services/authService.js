//authService.js
require('dotenv').config();
const pool = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');
const { OAuth2Client } = require('google-auth-library');
const admin = require('firebase-admin');
const fs = require('fs');

const { schema, tables } = config.db;

// Initialize Google OAuth2 client
const client = new OAuth2Client(process.env.CLIENT_ID);

// 🔥 Initialize Firebase Admin SDK from JSON file
if (!admin.apps.length) {
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    logger.info('🔍 Firebase initialization attempt:', {
      credPath: credPath,
      fileExists: credPath ? fs.existsSync(credPath) : false
    });
    
    if (credPath && fs.existsSync(credPath)) {
      // Use JSON file (mounted from Jenkins secret)
      const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || serviceAccount.database_url
      });
      
      logger.info('✅ Firebase Admin SDK initialized from JSON file');
    } else {
      throw new Error(`Firebase credentials file not found at: ${credPath}`);
    }
  } catch (error) {
    logger.error('❌ Firebase initialization error:', {
      message: error.message,
      stack: error.stack
    });
    logger.warn('⚠️ App will continue without Firebase');
  }
}

// Safe database export
let db;
try {
  if (admin.apps.length > 0) {
    db = admin.database();
    logger.info('✅ Firebase Database instance created');
  }
} catch (error) {
  logger.error('❌ Firebase database not available:', error.message);
}

// Centralized table and column names
const LOGIN_TABLE = `"${schema}"."${tables.login}"`;
const USER_PROFILE_TABLE = `"${schema}"."${tables.userProfile}"`;

const LOGIN_COLUMNS = {
  USERNAME: 'USERNAME',
  PASSWORD: 'PASSWORD',
  USER_TYPE: 'USER_TYPE',
  IS_ACTIVE: 'IS_ACTIVE',
  USER_ID: 'USER_ID',
  AUTH_PROVIDER: 'AUTH_PROVIDER',
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
  GOOGLE_ONLY_ACCOUNT: 'ERR007',
  NO_PASSWORD_SET: 'ERR008',
};

// Gender conversion function
const convertGender = (gender) => {
  if (!gender) return null;
  
  const genderStr = gender.toString().toLowerCase();
  if (genderStr === 'male' || genderStr === 'm' || genderStr === '0') {
    return 'M';
  } else if (genderStr === 'female' || genderStr === 'f' || genderStr === '1') {
    return 'F';
  }
  
  return gender.length > 0 ? gender.charAt(0).toUpperCase() : null;
};

// ========== REGISTER USER ==========
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

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const userCheckQuery = `
      SELECT 
        p."${PROFILE_COLUMNS.EMAIL}",
        l."${LOGIN_COLUMNS.AUTH_PROVIDER}"
      FROM ${LOGIN_TABLE} l
      LEFT JOIN ${USER_PROFILE_TABLE} p 
        ON l."${LOGIN_COLUMNS.USER_ID}" = p."${PROFILE_COLUMNS.USER_ID}"
      WHERE p."${PROFILE_COLUMNS.EMAIL}" = $1
    `;
    const existingUser = await dbClient.query(userCheckQuery, [email]);

    if (existingUser.rows.length > 0) {
      const authProvider = existingUser.rows[0][LOGIN_COLUMNS.AUTH_PROVIDER];
      
      await dbClient.query('ROLLBACK');
      
      if (authProvider === 'google') {
        logger.info(`Registration attempt for Google-registered email: ${email}`);
        return {
          status: 400,
          data: {
            error: 'This email is registered with Google. Please use "Login with Google" or contact support to add password.',
            code: 'GOOGLE_ACCOUNT_EXISTS',
          },
        };
      }
      
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
      ("${LOGIN_COLUMNS.USERNAME}", "${LOGIN_COLUMNS.PASSWORD}", "${LOGIN_COLUMNS.USER_TYPE}", 
       "${LOGIN_COLUMNS.IS_ACTIVE}", "${LOGIN_COLUMNS.AUTH_PROVIDER}")
      VALUES ($1, $2, $3, $4, $5) RETURNING "${LOGIN_COLUMNS.USER_ID}"
    `;
    const userRes = await dbClient.query(insertLoginUserQuery, [
      email,
      hashedPassword,
      USER_TYPES.TENANT,
      ACTIVE_STATUS.ACTIVE,
      'local'
    ]);

    const userId = userRes.rows[0][LOGIN_COLUMNS.USER_ID];

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

    const convertedGender = convertGender(gender);

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
      convertedGender,
      null,
    ]);

    // 🔥 CREATE USER IN FIREBASE
    try {
      await db.ref(`users/${userId}`).set({
        email: email,
        displayName: full_name,
        photoURL: '',
        phone: '',
        online: false,
        lastSeen: Date.now(),
        createdAt: Date.now(),
        userType: USER_TYPES.TENANT,
        authProvider: 'local'
      });
      logger.info(`Firebase user created for userId: ${userId}`);
    } catch (fbError) {
      logger.error('Firebase user creation failed:', fbError.message);
    }
    
    await dbClient.query('COMMIT');

    logger.info(`User registered with email: ${email}`);
    return { status: 201, data: { message: 'User registered successfully' } };
  } catch (error) {
    await dbClient.query('ROLLBACK');
    logger.error('Database error during registration:', {
      message: error.message,
      stack: error.stack
    });
    return {
      status: 500,
      data: { error: 'Database error', code: ERROR_CODES.DATABASE_ERROR },
    };
  } finally {
    dbClient.release();
  }
};

// ========== LOGIN USER ==========
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
      SELECT 
        l."${LOGIN_COLUMNS.USER_ID}",
        l."${LOGIN_COLUMNS.USERNAME}",
        l."${LOGIN_COLUMNS.PASSWORD}",
        l."${LOGIN_COLUMNS.USER_TYPE}",
        l."${LOGIN_COLUMNS.AUTH_PROVIDER}",
        p."${PROFILE_COLUMNS.FULL_NAME}",
        p."${PROFILE_COLUMNS.PHONE_NUMBER}",
        p."${PROFILE_COLUMNS.PROFILE_IMAGE}"
      FROM ${LOGIN_TABLE} l
      LEFT JOIN ${USER_PROFILE_TABLE} p ON l."${LOGIN_COLUMNS.USER_ID}" = p."${PROFILE_COLUMNS.USER_ID}"
      WHERE l."${LOGIN_COLUMNS.IS_ACTIVE}" = $1 AND l."${LOGIN_COLUMNS.USERNAME}" = $2
    `;
    const result = await pool.query(query, [ACTIVE_STATUS.ACTIVE, email]);
    const user = result.rows[0];

    if (!user) {
      logger.warn(`Login failed for non-existing user: ${email}`);
      return {
        status: 401,
        data: { error: 'Invalid email or password', code: ERROR_CODES.USER_NOT_FOUND },
      };
    }

    const authProvider = user[LOGIN_COLUMNS.AUTH_PROVIDER];
    
    if (authProvider === 'google' && !user[LOGIN_COLUMNS.PASSWORD]) {
      logger.warn(`Password login attempt for Google-only account: ${email}`);
      return {
        status: 401,
        data: { 
          error: 'This account was created with Google. Please use "Login with Google" button.',
          code: ERROR_CODES.GOOGLE_ONLY_ACCOUNT,
        },
      };
    }

    if (!user[LOGIN_COLUMNS.PASSWORD]) {
      logger.warn(`No password set for account: ${email}`);
      return {
        status: 401,
        data: { 
          error: 'No password set for this account.',
          code: ERROR_CODES.NO_PASSWORD_SET,
        },
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

    const userId = user[LOGIN_COLUMNS.USER_ID];

    // 🔥 UPDATE FIREBASE USER STATUS
    try {
      const firebaseUserRef = db.ref(`users/${userId}`);
      const snapshot = await firebaseUserRef.once('value');
      
      if (!snapshot.exists()) {
        await firebaseUserRef.set({
          email: email,
          displayName: user[PROFILE_COLUMNS.FULL_NAME] || '',
          photoURL: user[PROFILE_COLUMNS.PROFILE_IMAGE] || '',
          phone: user[PROFILE_COLUMNS.PHONE_NUMBER] || '',
          online: true,
          lastSeen: Date.now(),
          createdAt: Date.now(),
          userType: user[LOGIN_COLUMNS.USER_TYPE],
          authProvider: authProvider || 'local'
        });
        logger.info(`Firebase user created on login for userId: ${userId}`);
      } else {
        await firebaseUserRef.update({
          online: true,
          lastSeen: Date.now()
        });
        logger.info(`Firebase user status updated for userId: ${userId}`);
      }
    } catch (fbError) {
      logger.error('Firebase update failed on login:', fbError.message);
    }

    const token = jwt.sign({ userId: userId }, process.env.JWT_SECRET, { expiresIn });

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

// ========== GET PROFILE ==========
exports.getUserProfile = async (userId) => {
  const query = `
    SELECT 
      p."${PROFILE_COLUMNS.USER_ID}",
      p."${PROFILE_COLUMNS.FULL_NAME}", 
      p."${PROFILE_COLUMNS.PHONE_NUMBER}", 
      p."${PROFILE_COLUMNS.EMAIL}",
      p."${PROFILE_COLUMNS.ADDRESS}", 
      p."${PROFILE_COLUMNS.GENDER}", 
      p."${PROFILE_COLUMNS.PROFILE_IMAGE}",
      l."${LOGIN_COLUMNS.USER_TYPE}",
      l."${LOGIN_COLUMNS.AUTH_PROVIDER}"
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

// ========== GOOGLE LOGIN ==========
exports.loginWithGoogle = async (id_token) => {
  const dbClient = await pool.connect();
  try {
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
    const gender = convertGender(payload.gender);

    await dbClient.query('BEGIN');

    const userCheckRes = await dbClient.query(
      `SELECT 
        u."${LOGIN_COLUMNS.USER_ID}", 
        u."${LOGIN_COLUMNS.USER_TYPE}",
        u."${LOGIN_COLUMNS.AUTH_PROVIDER}"
       FROM ${LOGIN_TABLE} u
       LEFT JOIN ${USER_PROFILE_TABLE} p ON u."${LOGIN_COLUMNS.USER_ID}" = p."${PROFILE_COLUMNS.USER_ID}"
       WHERE p."${PROFILE_COLUMNS.EMAIL}" = $1`,
      [email]
    );
    
    let userId, userType, authProvider;
    
    if (userCheckRes.rows.length === 0) {
      const insertLoginRes = await dbClient.query(
        `INSERT INTO ${LOGIN_TABLE} 
         ("${LOGIN_COLUMNS.USERNAME}", "${LOGIN_COLUMNS.PASSWORD}", "${LOGIN_COLUMNS.USER_TYPE}", 
          "${LOGIN_COLUMNS.IS_ACTIVE}", "${LOGIN_COLUMNS.AUTH_PROVIDER}")
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING "${LOGIN_COLUMNS.USER_ID}", "${LOGIN_COLUMNS.USER_TYPE}"`,
        [email, null, USER_TYPES.TENANT, ACTIVE_STATUS.ACTIVE, 'google']
      );
      
      userId = insertLoginRes.rows[0][LOGIN_COLUMNS.USER_ID];
      userType = insertLoginRes.rows[0][LOGIN_COLUMNS.USER_TYPE];
      authProvider = 'google';
      
      await dbClient.query(
        `INSERT INTO ${USER_PROFILE_TABLE} 
         ("${PROFILE_COLUMNS.USER_ID}", "${PROFILE_COLUMNS.FULL_NAME}", "${PROFILE_COLUMNS.PHONE_NUMBER}", 
          "${PROFILE_COLUMNS.EMAIL}", "${PROFILE_COLUMNS.ADDRESS}", "${PROFILE_COLUMNS.GENDER}", "${PROFILE_COLUMNS.PROFILE_IMAGE}")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, full_name, null, email, null, gender, picture]
      );

      // 🔥 CREATE FIREBASE USER
      try {
        await db.ref(`users/${userId}`).set({
          email: email,
          displayName: full_name,
          photoURL: picture || '',
          phone: '',
          online: true,
          lastSeen: Date.now(),
          createdAt: Date.now(),
          userType: userType,
          authProvider: 'google'
        });
        logger.info(`Firebase user created for Google login userId: ${userId}`);
      } catch (fbError) {
        logger.error('Firebase user creation failed for Google login:', fbError.message);
      }
    } else {
      userId = userCheckRes.rows[0][LOGIN_COLUMNS.USER_ID];
      userType = userCheckRes.rows[0][LOGIN_COLUMNS.USER_TYPE];
      authProvider = userCheckRes.rows[0][LOGIN_COLUMNS.AUTH_PROVIDER];

      if (authProvider === 'local') {
        await dbClient.query(
          `UPDATE ${LOGIN_TABLE} 
           SET "${LOGIN_COLUMNS.AUTH_PROVIDER}" = 'both'
           WHERE "${LOGIN_COLUMNS.USER_ID}" = $1`,
          [userId]
        );
        authProvider = 'both';
        logger.info(`Updated auth provider to 'both' for userId: ${userId}`);
      }

      // 🔥 UPDATE FIREBASE
      try {
        await db.ref(`users/${userId}`).update({
          online: true,
          lastSeen: Date.now(),
          authProvider: authProvider
        });
        logger.info(`Firebase status updated for Google login userId: ${userId}`);
      } catch (fbError) {
        logger.error('Firebase update failed for Google login:', fbError.message);
      }
    }

    await dbClient.query('COMMIT');

    const token = jwt.sign(
      { userId, user_type: userType, email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRATION || "12h" }
    );

    logger.info(`User logged in with Google: ${email}, auth_provider: ${authProvider}`);
    return { status: 200, data: { message: "Google login successful", token } };
  } catch (err) {
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

// module.exports = {
//   registerUser: exports.registerUser,
//   loginUser: exports.loginUser,
//   getUserProfile: exports.getUserProfile,
//   loginWithGoogle: exports.loginWithGoogle,
//   admin,
//   db
// };
