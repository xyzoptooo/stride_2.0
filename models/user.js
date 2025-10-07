import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true, unique: true },
  name: String,
  email: String,
  aiPreferences: {
    enabled: { type: Boolean, default: false },
    updatedAt: { type: Date, default: Date.now }
  },
  // Add more fields as needed
});

export default mongoose.model('User', UserSchema);