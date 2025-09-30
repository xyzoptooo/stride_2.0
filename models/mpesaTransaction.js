import mongoose from 'mongoose';

const mpesaTransactionSchema = new mongoose.Schema({
  supabaseId: {
    type: String,
    required: true,
    index: true
  },
  transactionId: {
    type: String,
    unique: true,
    sparse: true
  },
  phoneNumber: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  plan: {
    type: String,
    required: true,
    enum: ['monthly', 'annual', 'lifetime']
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  mpesaReceiptNumber: String,
  accountReference: String,
  transactionDate: {
    type: Date,
    default: Date.now
  },
  resultCode: Number,
  resultDesc: String,
  errorMessage: String,
  raw: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

// Index for querying recent transactions
mpesaTransactionSchema.index({ transactionDate: -1 });
mpesaTransactionSchema.index({ status: 1, transactionDate: -1 });

const MpesaTransaction = mongoose.model('MpesaTransaction', mpesaTransactionSchema);

export default MpesaTransaction;