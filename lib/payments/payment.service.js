/**
 * Service logic for Article model
 */
const crypto = require('crypto');
const squareConnect = require('square-connect');
const { ArticleService } = require('../articles/article.service');
const { PaymentModel } = require('./payment.model');

class PaymentService {
    constructor() {
        // Set Square Connect credentials and environment
        const defaultClient = squareConnect.ApiClient.instance;

        // Configure OAuth2 access token for authorization: oauth2
        const oauth2 = defaultClient.authentications['oauth2'];
        oauth2.accessToken = 'SQUARE_SANDBOX_ACCESS_TOKEN';

        // Set 'basePath' to switch between sandbox env and production env
        // sandbox: https://connect.squareupsandbox.com
        // production: https://connect.squareup.com
        defaultClient.basePath = 'https://connect.squareupsandbox.com';
        
        // Charge the customer's card
        this.paymentsApi = new squareConnect.PaymentsApi();
        this.paymentModel = PaymentModel;
        this.articleService = new ArticleService();
    }

    async startCronJob() {
        let session = await this.payment.db.startSession();
        try {
            // look for all payments that have taken more than 5 minutes
            let cutoffDate = new Date();
            cutoffDate.setTime(cutoffDate.getTime() - 1000 * 60 * 5)

            let pendingExpiredPayments = await this.payment.find(
                {
                    $or: [
                        { status: 'pending' },
                        { status: 'approved' },
                        { status: 'confirmed' },
                    ],
                    created: {
                        $lt: cutoffDate.toISOString()
                    }
                }
            ).session(session);
            if (!pendingExpiredPayments.length) {
                console.log('No expired payments');
                return;
            }
            
            let paymentUpdatePromises = 
                pendingExpiredPayments.map((payment) => {
                    let paymentPromise;
                    switch(payment.status) {
                        case 'pending':
                            // set payment status to error...
                            paymentPromise = this.setPaymentToErrorHelper(payment, session);
                            break;
                        case 'approved':
                            // Cancel payment and set payment status to error...
                            paymentPromise = this.cancelApprovedPayment(payment, session);
                            break;
                        case 'confirmed':
                            // complete payment...
                            paymentPromise = this.completePaymentHelper(payment, session);
                            break;
                    }
                    return paymentPromise.catch(e => {console.log(e);});               
                });

            let values =  await Promise.all(paymentUpdatePromises);
            session.endSession();
            return values;
        } catch (error) {
            console.log('Cron job failed...', error);
            session.endSession();
            throw error;
        }
    }

    /**
     * Completes an approved payment
     * @param paymentID 
     */
    async completePayment(paymentID) {
        try {
            const param = paymentID;

            // get response from square
            let { payment, errors } = await this.paymentsApi.completePayment(param);

            if ( errors && errors.length ) {
                // if there are errors, create a comprehensive error string
                let errorMessage = errors.reduce((accumulator, currentValue) => accumulator.concat(currentValue), '');
                throw new Error(errorMessage);
            }
            return payment;
        } catch(error) {
            console.log(`Error completing square payment: ${error}`);
            throw error;
        }
    }

    /**
     * Cancels an approved payment
     * @param paymentID 
     */
    async cancelPayment(paymentID) {
        try {
            if ( paymentID === 'bypass' ) {
                return {};
            }
            const param = paymentID;
            // get response from square
            let { payment, errors } = await this.paymentsApi.cancelPayment(param);

            if ( errors && errors.length ) {
                // if there are errors, create a comprehensive error string
                let errorMessage = errors.reduce((accumulator, currentValue) => accumulator.concat(currentValue), '');
                throw new Error(errorMessage);
            }
            return payment;
        } catch(error) {
            console.log(`Error canceling square payment: ${error}`);
            throw error;
        }
    }

    /**
     * Simple helper to set paymentObject status to Error
     * @param paymentObject : Mongo Document Object
     * @param concurrentSession : Session passed from caller
     */
    async setPaymentToErrorHelper(paymentObject, concurrentSession) {
        console.log('Erroring payment ', paymentObject._id);

        await concurrentSession.withTransaction(async () => {
            // update payment
            paymentObject.status = PaymentStatus.Error;
            return await paymentObject.save({session: concurrentSession}); 
        });

        return paymentObject;
    }

    /**
     * Simple helper to cancel an approved payment
     * @param paymentObject : Mongo Document Object
     * @param concurrentSession : Session passed from caller
     */
    async cancelApprovedPayment(paymentObject, concurrentSession) {
        try {
            await this.cancelPayment(paymentObject.paymentActionId);
        } catch (e) {
            console.log(e); // Soft error...
        }
        await this.setPaymentToErrorHelper(paymentObject, concurrentSession);
    }

    /**
     * Simple helper to complete payment
     * @param paymentObject : Mongo Document Object
     * @param concurrentSession : Session passed from caller
     */
    async completePaymentHelper(paymentObject, concurrentSession) {
        // Complete the payment!!
        let completePaymentSquareResult, paymentUpdate;
        try {
            if ( paymentObject.paymentActionId !== 'bypass' ) {
                completePaymentSquareResult = await this.completePayment(paymentObject.paymentActionId);
            }
        } catch(e) {
            // NOTE: There should really be no issues in terms of logic. Our side we are able to create payment.
            //       Square's side they were able to approve the payment...
            // Solution: Just retry in the CRON job...
            console.log('Error completing payment: ', e);
            throw e;
        }

        await concurrentSession.withTransaction(async () => {
            // start queries
            paymentObject.status = PaymentStatus.Completed;
            paymentUpdate = await paymentObject.save({session: concurrentSession});
            // let all queries complete
            return paymentUpdate;
        });
        return paymentObject;
    }

    /**
     * Creates an article...
     * @param {*} articleData 
     * @param {*} concurrentSession 
     */
    async createArticleUpdateFunction(articleData, concurrentSession) {
        return await new ArticleService().createArticle(articleData, concurrentSession);
    }

    /**
     * Initiates payment and creates article if success.
     * @param {*} nonce 
     * @param {*} articleData 
     */
    async createArticle(nonce, articleData) {
        // Query to search uniqueness on
        let searchQuery = {
            // action data associated with ArticleCreation
            actionType: 'ArticleCreation',
            // ensure uniqueness on title and author
            'actionData.title': articleData.title,
            'actionData.author': articleData.author,
        };
        // Query to update payments
        let setQuery = {
            actionType: 'ArticleCreation',
            actionData: articleData,
        };
        let articleCost = 1000;
        return await this.paymentsFactory(nonce, searchQuery, setQuery, articleCost, this.createArticleUpdateFunction);
    }
    
    async paymentsFactory(nonce, searchQuery, setQuery, paymentAmountUsd, modelUpdateFunction) {
        let session = await this.payment.db.startSession();
        try {
            let paymentSetQuery = {
                ...setQuery,
                status: 'pending',
                paymentAmountUsd: paymentAmountUsd,
            };
            // create Payment object if there are no pending, approved, or confirmed payments for the action
            let paymentObject = await this.paymentModel.findOneAndUpdate(
                {
                    ...searchQuery,
                    $or: [
                        { status: 'pending' },
                        { status: 'approved' },
                        { status: 'confirmed' }
                    ]
                },
                {
                    $setOnInsert: paymentSetQuery, // Set if no document matches searchQuery
                },
                {
                    new: false, // returns null if new document
                    upsert: true,
                }
            ).session(session);
            // Presence of paymentObject means that there already exists a payment matching the searchQuery
            if ( paymentObject ) {
                throw new Error('Payment has either been done or is being processed');
            }
            // otherwise, retrieve newly created document
            paymentObject = await this.paymentModel.findOne( { ...searchQuery, status: 'pending' } ).session(session);
            // APPROVE
            console.log('Approving payment: ', paymentObject._id);
            let squareResult;
            try {
                if (fee) {
                    squareResult = await this.makePayment(nonce, fee, paymentObject._id.toString());
                    if ( squareResult.status !== SquarePaymentStatus.Approved ) {
                        throw new Error('Payment not approved');
                    }
                    
                }
                // update status to approved...
                paymentObject.paymentActionId = (squareResult)? squareResult.id : 'bypass';
                paymentObject.status = PaymentStatus.Approved;
                await paymentObject.save({session});
            } catch (error) {
                // if error, set payment status to Error...
                await this.setPaymentToErrorHelper(paymentObject, session);
                throw error;
            }

            console.log('Confirming payment: ', paymentObject._id);
            // CONFIRM
            let modelObject, paymentUpdate;
            try {
                // create the model
                await session.withTransaction(async () => {
                    // start queries
                    modelObject = await modelUpdateFunction(data, paymentObject._id, session);
                    paymentObject.status = PaymentStatus.Confirmed;
                    // paymentObject.paymentActionId = (squareResult)? squareResult.id : 'bypass';
                
                    paymentUpdate = await paymentObject.save({session: session});
                    // let all queries complete
                    return paymentUpdate;
                });
            } catch(error) {
                
                await this.cancelApprovedPayment(paymentObject, session);
                throw error;
            }
            // COMPLETE
            console.log('Completing payment: ', paymentObject._id);
            paymentObject = await this.completePaymentHelper(paymentObject, session);
            session.endSession();
            return { model: modelObject, payment: paymentObject };
        } catch (error) {
            console.log(error);
            session.endSession();
            throw error;
        }
    }

    /**
     * Utilizes square platform to initiate a payment.
     * @param nonce : nonce generated by client
     * @param amountInUsd : Payment amount in USD.
     * @param referenceId : internal representation of payment to associated with external resource
     */
    async makePayment(nonce, amountInUsd, referenceId) {
        try {
            const idempotency_key = crypto.randomBytes(22).toString('hex');

            // Charge the customer's card
            const request_body = {
                source_id: nonce,
                amount_money: {
                    amount: amountInUsd * 100,
                    currency: 'USD'
                },
                idempotency_key: idempotency_key,
                reference_id: referenceId,
                autoComplete: false,
            };

            // get response from square
            let { payment, errors } = await this.paymentsApi.createPayment(request_body);

            // if there are errors, create a comprehensive error string
            if ( errors && errors.length ) {
                let errorMessage = errors.reduce((accumulator, currentValue) => accumulator.concat(currentValue), '');
                throw new Error(errorMessage);
            }
            return payment;
        } catch(error) {
            console.error(`Error making square payment: ${error}`);
            throw error;
        }
    }
}

module.exports = {
    PaymentService
};