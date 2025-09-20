const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true, unique: true },
  name: String,
  email: String,
  // Add more fields as needed
});

module.exports = mongoose.model('User', UserSchema);