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

  // Calendar Event reminders
  const events = await Activity.find({
    type: 'USER_EVENT',
    startTime: { $gte: now, $lte: soon } 
  });
  for (const event of events) {
    const user = await User.findOne({ supabaseId: event.supabaseId });
    if (user && user.email) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: `Reminder: ${event.title}`,
        text: `This is a reminder for your event: "${event.title}", starting at ${new Date(event.startTime).toLocaleString()}.`,
      });
      console.log(`Sent event reminder to ${user.email} for event ${event._id}`);
    }
  }

  // Assignment deadline reminders & overdue
  const assignments = await Assignment.find({
    $or: [
      { reminder: { $gte: now, $lte: soon } },
      { dueDate: { $lt: now }, progress: { $lt: 100 }, isCompleted: false }
    ]
  }).populate('course', 'name');
  for (const assignment of assignments) {
    const user = await User.findOne({ supabaseId: assignment.supabaseId });
    if (user && user.email) {
      let subject, text;
      const courseName = assignment.course ? ` for course "${assignment.course.name}"` : '';
      if (assignment.dueDate < now) {
        subject = `Overdue Assignment: ${assignment.title}`;
        text = `Your assignment "${assignment.title}"${courseName} is overdue! The due date was ${new Date(assignment.dueDate).toLocaleString()}.`;
      } else {
        subject = `Assignment Reminder: ${assignment.title}`;
        text = `You have an upcoming assignment "${assignment.title}"${courseName} due on ${new Date(assignment.dueDate).toLocaleString()}.`;
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
        text: `Reminder for your note: "${note.title}".\n\n${note.content ? note.content.substring(0, 200) : ''}...`,
      });
      console.log(`Sent note reminder to ${user.email} for note ${note._id}`);
    }
  }
}

sendReminders().then(() => mongoose.disconnect());
