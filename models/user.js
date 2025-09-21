import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  supabaseId: { type: String, required: true, unique: true },
  name: String,
  email: String,
  // Add more fields as needed
});

export default mongoose.model('User', UserSchema);