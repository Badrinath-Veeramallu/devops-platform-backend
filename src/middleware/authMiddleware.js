const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Middleware to verify JWT and attach authenticated user to req.user
 */
const protect = async (req, res, next) => {
  let token;

  // 1. Check for Bearer token in Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];

      // 2. Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // 3. Retrieve user from database (never include password)
      const user = await User.findById(decoded.id).select("-password");

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "User not found or account no longer active",
        });
      }

      // Check if user is email verified
      if (!user.isEmailVerified) {
        return res.status(403).json({
          success: false,
          message: "Email address is not verified. Access forbidden.",
          isEmailVerified: false,
        });
      }

      // 4. Attach authenticated user to request object
      req.user = user;
      return next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Token has expired, please log in again",
        });
      }

      return res.status(401).json({
        success: false,
        message: "Invalid token, authorization denied",
      });
    }
  }

  // If no token found in header
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Not authorized, no token provided",
    });
  }
};

module.exports = { protect };
