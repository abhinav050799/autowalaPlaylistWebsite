const userManager = require('./userManager');
const CallLog = require('./models/CallLog');

module.exports = function(io) {
  
  io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);
    
    // Add user to system
    userManager.addUser(socket.id, {
      connectedAt: new Date()
    });

    // Send online count
    io.emit('online_count', userManager.getOnlineCount());

    // ===== RING NEW USER IF SOMEONE IS CALLING =====
    if (userManager.callerId && userManager.callerId !== socket.id) {
      console.log('🔔 New user joined during active call, ringing them');
      
      const user = userManager.onlineUsers.get(socket.id);
      if (user && user.status === 'idle') {
        user.status = 'ringing';
        userManager.ringingUsers.add(socket.id);
        
        // Send incoming call to new user
        socket.emit('incoming_call', {
          from: userManager.callerId,
          timeout: 20
        });
        
        // Update caller's count
        io.to(userManager.callerId).emit('ringing_update', {
          count: userManager.ringingUsers.size
        });
      }
    }

    // ===== START CALLING =====
    socket.on('start_calling', () => {
      console.log('📞 User wants to call:', socket.id);
      
      const result = userManager.startCalling(socket.id);
      
      if (result.error) {
        socket.emit('call_error', { message: result.error });
        return;
      }
      
      // Always tell caller they are ringing
      socket.emit('ringing_users', {
        count: result.availableUsers.length,
        timeout: result.timeout,
        waiting: true  // Waiting for users
      });
      
      // Ring available users
      if (result.availableUsers.length > 0) {
        result.availableUsers.forEach(userId => {
          io.to(userId).emit('incoming_call', {
            from: socket.id,
            timeout: result.timeout
          });
        });
        console.log(`🔔 Ringing ${result.availableUsers.length} users`);
      } else {
        console.log('⏳ No users yet, but caller is waiting...');
      }
    });

    // ===== PICK UP CALL =====
    socket.on('pick_up_call', () => {
      console.log('✅ User picking up:', socket.id);
      
      const result = userManager.pickUpCall(socket.id);
      
      if (result.error) {
        socket.emit('call_error', { message: result.error });
        return;
      }
      
      // Connect caller and answerer
      io.to(result.callerId).emit('call_accepted', {
        partnerId: result.answererId,
        initiator: true
      });
      
      io.to(result.answererId).emit('call_accepted', {
        partnerId: result.callerId,
        initiator: false
      });
      
      // Notify others
      if (result.otherUsers) {
        result.otherUsers.forEach(userId => {
          io.to(userId).emit('call_missed', {
            message: 'Someone else picked up'
          });
        });
      }
    });

    // ===== DECLINE CALL =====
    socket.on('decline_call', () => {
      console.log('❌ User declined:', socket.id);
      
      userManager.ringingUsers.delete(socket.id);
      const user = userManager.onlineUsers.get(socket.id);
      if (user) user.status = 'idle';
      
      if (userManager.ringingUsers.size === 0) {
        // No one left ringing, but caller stays active waiting for new users
        const callerId = userManager.callerId;
        if (callerId) {
          io.to(callerId).emit('ringing_update', {
            count: 0,
            message: 'Waiting for more users to come online...'
          });
        }
      } else {
        const callerId = userManager.callerId;
        if (callerId) {
          io.to(callerId).emit('ringing_update', {
            count: userManager.ringingUsers.size
          });
        }
      }
    });

    // ===== CANCEL CALLING =====
    socket.on('cancel_calling', () => {
      console.log('🚫 Caller cancelled:', socket.id);
      
      const result = userManager.cancelCall(socket.id);
      
      if (result && result.ringingUsers) {
        result.ringingUsers.forEach(userId => {
          io.to(userId).emit('call_cancelled');
        });
      }
    });

    // ===== NO ONE ANSWERED (Timeout) =====
    // Handle the timeout internally
    const originalReset = userManager.resetCall.bind(userManager);
    userManager.handleNoAnswer = function() {
      console.log('⏰ No one answered');
      
      if (this.callerId) {
        io.to(this.callerId).emit('no_one_answered');
      }
      
      const ringingIds = Array.from(this.ringingUsers);
      ringingIds.forEach(id => {
        io.to(id).emit('call_cancelled');
        const user = this.onlineUsers.get(id);
        if (user) user.status = 'idle';
      });
      
      this.resetCall();
    };

    // ===== WEBRTC SIGNALING =====
    socket.on('offer', (data) => {
      io.to(data.partnerId).emit('offer', {
        offer: data.offer,
        from: socket.id
      });
    });

    socket.on('answer', (data) => {
      io.to(data.partnerId).emit('answer', {
        answer: data.answer,
        from: socket.id
      });
    });

    socket.on('ice_candidate', (data) => {
      io.to(data.partnerId).emit('ice_candidate', {
        candidate: data.candidate,
        from: socket.id
      });
    });

    // ===== CALL STARTED =====
    socket.on('call_started', async (data) => {
      console.log('🎙️ Call started:', socket.id, '<->', data.partnerId);
      
      try {
        const callLog = new CallLog({
          user1: socket.id,
          user2: data.partnerId,
          startedAt: new Date(),
          status: 'active'
        });
        await callLog.save();
      } catch (err) {
        console.error('❌ Failed to save call log:', err);
      }
    });

    // ===== SKIP / NEXT =====
    socket.on('skip_partner', () => {
      console.log('⏭️ Skip:', socket.id);
      
      const partner = userManager.getPartner(socket.id);
      if (partner) {
        io.to(partner).emit('partner_skipped');
        endCallInDatabase(socket.id);
        
        userManager.removeUser(socket.id);
        userManager.addUser(socket.id, { connectedAt: new Date() });
        
        const partnerUser = userManager.onlineUsers.get(partner);
        if (partnerUser) partnerUser.status = 'idle';
        userManager.activePairs.delete(partner);
        userManager.activePairs.delete(socket.id);
      }
    });

    // ===== END CALL =====
    socket.on('end_call', () => {
      console.log('❌ End call:', socket.id);
      
      const partner = userManager.getPartner(socket.id);
      if (partner) {
        io.to(partner).emit('call_ended');
        endCallInDatabase(socket.id);
        
        const partnerUser = userManager.onlineUsers.get(partner);
        if (partnerUser) partnerUser.status = 'idle';
        userManager.activePairs.delete(partner);
        userManager.activePairs.delete(socket.id);
      }
    });

    // ===== CHAT =====
    socket.on('send_message', (data) => {
      const partner = userManager.getPartner(socket.id);
      if (partner) {
        io.to(partner).emit('receive_message', {
          message: data.message,
          from: socket.id,
          timestamp: new Date()
        });
      }
    });

    socket.on('typing', (data) => {
      const partner = userManager.getPartner(socket.id);
      if (partner) {
        io.to(partner).emit('partner_typing', {
          isTyping: data.isTyping
        });
      }
    });

    // ===== DISCONNECT =====
    socket.on('disconnect', async () => {
      console.log('👋 Disconnected:', socket.id);
      
      // If caller disconnects while ringing
      if (userManager.callerId === socket.id) {
        const ringingIds = Array.from(userManager.ringingUsers);
        ringingIds.forEach(id => {
          io.to(id).emit('call_cancelled');
        });
        userManager.resetCall();
      }
      
      // If ringing user disconnects
      if (userManager.ringingUsers.has(socket.id)) {
        userManager.ringingUsers.delete(socket.id);
        if (userManager.callerId) {
          io.to(userManager.callerId).emit('ringing_update', {
            count: userManager.ringingUsers.size,
            message: userManager.ringingUsers.size === 0 ? 'Waiting for users...' : null
          });
        }
      }
      
      // Handle active call
      const partner = userManager.removeUser(socket.id);
      if (partner) {
        io.to(partner).emit('partner_disconnected');
        await endCallInDatabase(socket.id);
        
        const partnerUser = userManager.onlineUsers.get(partner);
        if (partnerUser) partnerUser.status = 'idle';
      }
      
      io.emit('online_count', userManager.getOnlineCount());
    });

    // ===== HELPER =====
    async function endCallInDatabase(socketId) {
      try {
        const callLog = await CallLog.findOne({
          $or: [
            { user1: socketId, status: 'active' },
            { user2: socketId, status: 'active' }
          ]
        }).sort({ startedAt: -1 }).limit(1);
        
        if (callLog) {
          callLog.endedAt = new Date();
          callLog.duration = Math.round((callLog.endedAt - callLog.startedAt) / 1000);
          callLog.status = callLog.duration < 5 ? 'missed' : 'ended';
          await callLog.save();
        }
      } catch (err) {
        console.error('❌ Failed to update call log:', err);
      }
    }
  });
};