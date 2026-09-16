import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Copy server/.env.example to server/.env and configure it.');
}
const allowedOrigins = new Set([process.env.CLIENT_URL || 'http://localhost:5173', 'http://127.0.0.1:5173']);
const corsOptions = {
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
};
const io = new Server(server, { cors: corsOptions });
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['citizen', 'volunteer', 'admin'], default: 'citizen' },
  skills: [String],
  availability: { type: Boolean, default: false },
  verified: { type: Boolean, default: false },
  location: { lat: Number, lng: Number }
}, { timestamps: true });
const emergencySchema = new mongoose.Schema({
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, required: true },
  severity: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], required: true },
  peopleAffected: { type: Number, min: 1, required: true },
  contactNumber: String,
  location: { lat: Number, lng: Number, address: String },
  priorityScore: Number,
  status: { type: String, enum: ['Reported', 'Matching', 'Volunteer Assigned', 'Volunteer En Route', 'Arrived', 'Assistance In Progress', 'Resolved', 'Cancelled'], default: 'Reported' },
  assignedVolunteer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });
emergencySchema.index({ 'location.lat': 1, 'location.lng': 1, status: 1 });
const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: String, relatedEmergency: mongoose.Schema.Types.ObjectId, read: { type: Boolean, default: false }
}, { timestamps: true });
const User = mongoose.model('User', userSchema);
const Emergency = mongoose.model('Emergency', emergencySchema);
const Notification = mongoose.model('Notification', notificationSchema);

const sign = user => jwt.sign({ id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Authentication required' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ message: 'Invalid or expired token' }); }
};
const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ message: 'Insufficient permissions' });
const priority = (severity, people) => ({ Low: 10, Medium: 30, High: 60, Critical: 90 }[severity] + Math.min(Number(people) * 2, 10));
const notify = async (userId, message, relatedEmergency) => {
  await Notification.create({ userId, message, relatedEmergency });
  io.to(`user:${userId}`).emit('notification', { message, relatedEmergency });
};

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'ResQLink API' }));
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { name, email, password, phone, role = 'citizen' } = req.body;
    if (!name || !email || !password || password.length < 8) return res.status(400).json({ message: 'Name, email and an 8+ character password are required' });
    if (!['citizen', 'volunteer'].includes(role)) return res.status(400).json({ message: 'Invalid registration role' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, phone, passwordHash, role });
    res.status(201).json({ token: sign(user), user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) { next(error); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email?.toLowerCase() });
    if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) return res.status(401).json({ message: 'Invalid email or password' });
    res.json({ token: sign(user), user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (error) { next(error); }
});
app.get('/api/emergencies', auth, async (req, res, next) => {
  try {
    const query = req.user.role === 'citizen' ? { reportedBy: req.user.id } : {};
    res.json(await Emergency.find(query).populate('assignedVolunteer', 'name phone skills').sort({ createdAt: -1 }).limit(100));
  } catch (error) { next(error); }
});
app.post('/api/emergencies', auth, roles('citizen', 'admin'), async (req, res, next) => {
  try {
    const { type, title, description, severity, peopleAffected, contactNumber, location } = req.body;
    if (!type || !title || !description || !severity || !location?.lat || !location?.lng) return res.status(400).json({ message: 'Type, title, description, severity and map location are required' });
    const emergency = await Emergency.create({ reportedBy: req.user.id, type, title, description, severity, peopleAffected: Number(peopleAffected) || 1, contactNumber, location, priorityScore: priority(severity, peopleAffected), status: 'Matching' });
    const volunteers = await User.find({ role: 'volunteer', verified: true, availability: true });
    volunteers.forEach(volunteer => notify(volunteer._id, `New ${severity.toLowerCase()} emergency nearby: ${title}`, emergency._id));
    io.emit('emergency:created', emergency);
    res.status(201).json(emergency);
  } catch (error) { next(error); }
});
app.patch('/api/emergencies/:id/status', auth, async (req, res, next) => {
  try {
    const emergency = await Emergency.findById(req.params.id);
    if (!emergency) return res.status(404).json({ message: 'Emergency not found' });
    if (req.user.role === 'citizen' && emergency.reportedBy.toString() !== req.user.id) return res.status(403).json({ message: 'Not your emergency' });
    emergency.status = req.body.status;
    await emergency.save();
    await notify(emergency.reportedBy, `Emergency "${emergency.title}" is now ${emergency.status}`, emergency._id);
    io.emit('emergency:updated', emergency);
    res.json(emergency);
  } catch (error) { next(error); }
});
app.post('/api/emergencies/:id/accept', auth, roles('volunteer'), async (req, res, next) => {
  try {
    const emergency = await Emergency.findOneAndUpdate({ _id: req.params.id, assignedVolunteer: null, status: { $in: ['Matching', 'Reported'] } }, { assignedVolunteer: req.user.id, status: 'Volunteer Assigned' }, { new: true }).populate('assignedVolunteer', 'name phone skills');
    if (!emergency) return res.status(409).json({ message: 'This emergency has already been assigned' });
    await notify(emergency.reportedBy, `Volunteer ${req.user.name} accepted your emergency`, emergency._id);
    io.emit('emergency:updated', emergency);
    res.json(emergency);
  } catch (error) { next(error); }
});
app.patch('/api/volunteers/me', auth, roles('volunteer'), async (req, res, next) => {
  try { const user = await User.findByIdAndUpdate(req.user.id, { $set: { availability: Boolean(req.body.availability), location: req.body.location, skills: req.body.skills } }, { new: true }).select('-passwordHash'); io.emit('volunteer:updated', user); res.json(user); } catch (error) { next(error); }
});
app.get('/api/notifications', auth, async (req, res, next) => {
  try { res.json(await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30)); } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ message: 'Unexpected server error' }); });
io.on('connection', socket => socket.on('identify', userId => socket.join(`user:${userId}`)));
const port = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/resqlink').then(() => server.listen(port, () => console.log(`ResQLink API listening on ${port}`))).catch(error => { console.error('MongoDB connection failed:', error.message); process.exit(1); });
