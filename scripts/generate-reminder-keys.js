#!/usr/bin/env node
import crypto from 'crypto';
import webPush from 'web-push';

const generateReminderEncryptionKey = () => crypto.randomBytes(32).toString('base64');

const generateVapidKeys = () => webPush.generateVAPIDKeys();

const reminderKey = generateReminderEncryptionKey();
const vapidKeys = generateVapidKeys();

const output = `\nGenerated Smart Reminder Secrets\n================================\n\nREMINDER_ENCRYPTION_KEY=${reminderKey}\nWEB_PUSH_VAPID_PUBLIC_KEY=${vapidKeys.publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${vapidKeys.privateKey}\n\nNext steps:\n1. Store these values securely.\n2. Update your Render service environment variables with the keys above.\n3. Redeploy the backend.\n\n`;

process.stdout.write(output);
