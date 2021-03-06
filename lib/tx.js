var ripple = require('ripple-lib'),
  remoteConnect = require('./remoteConnect');
/**
 *  opts
 *    remote
 *    address
 *    tx_hash
 *    ledger_index
 */
module.exports.getTx = function(opts, callback) {
  var remote = opts.remote,
    address = opts.address || opts.account,
    tx_hash = opts.tx_hash || opts.hash;

  if (!tx_hash) {
    callback(new Error('Invalid parameter: tx_hash. Must provide a transaction hash to look for'));
    return;
  }

  remoteConnect.ensureConnected(remote, function(err, connected){
    if (err) {
      callback(err);
      return;
    }

    remote.requestTx(tx_hash, function(err, tx){
      if (err) {
        callback(err);
        return;
      }

      callback(null, tx);
    });

  });
};


/*
 *  opts
 *    remote
 *    OutgoingTx
 *    src_address: '...',
 *    secret: '...',
 *    tx_json: {...}
 */
module.exports.submitTx = function(opts, callback) {

  var remote = opts.remote,
    OutgoingTx = opts.OutgoingTx,
    tx = opts.tx_json || opts.tx || opts,
    src_address = opts.src_address || tx.Account, 
    secret = opts.secret,
    initial_hash;

  if (!OutgoingTx) {
    console.log('Warning: no OutgoingTx queue given so there will be no way to associate the response from submitTx with a notification later');
  }

  remoteConnect.ensureConnected(remote, function(err, connected){
    if (err) {
      callback(err);
      return;
    }

    // Set secret
    try {
      remote.set_secret(src_address, secret);
    } catch (e) {
      callback(new Error('Invalid parameter: secret. Must provide valid Ripple account secret to sign transaction'));
      return;
    }

    // Determine if tx is already a ripple-lib Transaction or just json
    if (tx.constructor.name === 'Transaction') {

      tx.remote = remote;

    } else if (tx.constructor.name === 'Object') {

      // Special case for handling XRP given as an object,
      // ripple-lib doesn't like it so pass it as a string instead
      Object.keys(tx).forEach(function(key){
        if (typeof tx[key] === 'object' && tx[key].currency === 'XRP' && !tx[key].issuer) {
          tx[key] = '' + tx[key].value + 'XRP';
        }
      });

      // Create transaction
      try {
        tx = remote.transaction(tx);
      } catch (e) {
        callback(e);
        return;
      }
    } else {
      callback(new Error('Invalid parameter: tx. Must provide a ripple tx in JSON format or a ripple-lib Transaction object'));
    }

    // Setup event handlers

    tx.once('error', callback);

    // Once tx has been submitted to rippled, send the initial hash
    // back to the user and save the entry into the db
    tx.once('proposed', function(proposed) {

      initial_hash = proposed.tx_json.hash;

      tx.removeListener('error', callback);

      // save to db
      // TODO fix this scope with OutgoingTx
      if (OutgoingTx) {
        OutgoingTx
          .create({
            initial_hash: initial_hash,
            submitted_at_ledger: remote._ledger_current_index - 1,
            src_address: src_address,
            tx_type: tx.type || tx.tx_json.TransactionType,
            tx_state: 'submitted' 
          })
          .error(function(err){
            callback(new Error('Error saving to database. Please ensure that the database is configured and connected properly. You may need to run db-migrate, see the documentation for setup instructions. Error: ' + err));
          })
          .success(function(entry){
            // Send initial hash back to user
            callback(null, initial_hash);
          });
      } else {
        console.log('Transaction proposed with initial_hash: ' + initial_hash);
      }

    });      

    // Once the tx has been confirmed in the ledger, update the db entry
    // to associate the initial_hash with the final tx_hash
    tx.once('success', function(confirmed_tx) {

      // console.log('success: ' + JSON.stringify(confirmed_tx));

      // Update db entry with tx_hash and tx_result
      if (OutgoingTx) {
        OutgoingTx
          .update({
            // UPDATE
            tx_state: 'confirmed',
            tx_hash: confirmed_tx.transaction.hash, 
            tx_result: confirmed_tx.meta.TransactionResult
          }, {
            // WHERE
            initial_hash: initial_hash
          })
          .error(function(err){
            console.log('error updated OutgoingTx record: ' + err);
          })
          .success(function(){
            // console.log('update db entry for initial_hash: ' + initial_hash + ' with tx_hash: ' + confirmed_tx.transaction.hash);
          });
      } else {
        console.log('Transaction confirmed: ', confirmed_tx);
      }

    });

    tx.submit();

  });
    
};
