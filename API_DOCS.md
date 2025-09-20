# Semester Stride Planner Backend API Documentation

This document describes the available API endpoints for the backend service. All endpoints are prefixed with `/api` unless otherwise noted.

## Authentication
No authentication is required for most endpoints. For production, consider adding authentication.

---

## Users

### Create User
- **POST** `/api/users`
- **Body:** `{ supabaseId, name, email }`
- **Response:** Created user object

### Get User
- **GET** `/api/users/:supabaseId`
- **Response:** User object

---

## Assignments

### Create Assignment
- **POST** `/api/assignments`
- **Body:** Assignment fields (see model)
- **Response:** Created assignment object

### Get Assignments for User
- **GET** `/api/assignments/:supabaseId`
- **Response:** Array of assignments

---

## Notes

### Create Note
- **POST** `/api/notes`
- **Body:** Note fields (see model)
- **Response:** Created note object

### Get Notes for User
- **GET** `/api/notes/:supabaseId`
- **Response:** Array of notes

---

## Courses

### Create Course
- **POST** `/api/courses`
- **Body:** Course fields (see model)
- **Response:** Created course object

### Get Courses for User
- **GET** `/api/courses/:supabaseId`
- **Response:** Array of courses

---

## Activities

### Create Activity
- **POST** `/api/activities`
- **Body:** Activity fields (see model)
- **Response:** Created activity object

### Get Activities for User
- **GET** `/api/activities/:supabaseId`
- **Response:** Array of activities

---

## Syllabus Import

### Import Syllabus
- **POST** `/api/syllabus/import`
- **Form Data:** `file` (syllabus file)
- **Response:** Parsed assignments and courses

---

## AI Features

### Get Study Plan
- **GET** `/api/plan?userId=SUPABASE_ID`
- **Response:** AI-generated study plan

### Get Recommendations
- **POST** `/api/recommendations`
- **Body:** `{ supabaseId }`
- **Response:** AI-generated recommendations

---

## Mpesa Payments

### Initiate Payment
- **POST** `/api/mpesa/stkpush`
- **Body:** `{ phone, amount, accountReference, transactionDesc, plan }`
- **Response:** Payment initiation status

### Poll Payment Status
- **GET** `/api/mpesa/status?phone=PHONE&plan=PLAN`
- **Response:** Payment status

---

## Models
- See `/backend/models/` for field details for User, Assignment, Note, Course, Activity.

---

## Error Handling
- All endpoints return JSON with an `error` field on failure.

---

## Contact
For support, email: support@semesterstride.com
