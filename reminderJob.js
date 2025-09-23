import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Activity from './models/activity.js';
import Assignment from './models/assignment.js';
import Note from './models/note.js';
import User from './models/user.js';
import nodemailer from 'nodemailer';
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/semesterstride';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendReminders() {
  const now = new Date();
  const soon = new Date(now.getTime() + 60 * 60 * 1000); // next 1 hour

  // Event reminders
  const events = await Activity.find({ reminder: { $gte: now, $lte: soon } });
  for (const event of events) {
    const user = await User.findOne({ supabaseId: event.supabaseId });
    if (user && user.email) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: `Reminder: Upcoming Event - ${event.details || event.type}`,
        text: `You have an upcoming event: ${event.details || event.type} at ${event.date}.`,
      });
      console.log(`Sent event reminder to ${user.email} for event ${event._id}`);
    }
  }

  // Assignment deadline reminders & overdue
  const assignments = await Assignment.find({ $or: [
    { reminder: { $gte: now, $lte: soon } },
    { dueDate: { $lt: now }, progress: { $lt: 100 } }
  ] });
  for (const assignment of assignments) {
    const user = await User.findOne({ supabaseId: assignment.supabaseId });
    if (user && user.email) {
      let subject, text;
      if (assignment.dueDate < now && assignment.progress < 100) {
        subject = `Overdue Assignment: ${assignment.title}`;
        text = `Your assignment "${assignment.title}" for course "${assignment.course}" is overdue! Due date was ${assignment.dueDate}.`;
      } else {
        subject = `Assignment Reminder: ${assignment.title}`;
        text = `You have an upcoming assignment "${assignment.title}" for course "${assignment.course}" due on ${assignment.dueDate}.`;
      }
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject,
        text,
      });
      console.log(`Sent assignment reminder to ${user.email} for assignment ${assignment._id}`);
    }
  }

  // Note reminders
  const notes = await Note.find({ reminder: { $gte: now, $lte: soon } });
  for (const note of notes) {
    const user = await User.findOne({ supabaseId: note.supabaseId });
    if (user && user.email) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: `Note Reminder: ${note.title}`,
        text: `Reminder for your note: "${note.title}". ${note.content ? note.content.substring(0, 100) : ''}`,
      });
      console.log(`Sent note reminder to ${user.email} for note ${note._id}`);
    }
  }
}

sendReminders().then(() => mongoose.disconnect());
