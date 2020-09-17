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
        // look for all payments that have taken more than 5 minutes...
        let cutoffDate = new Date();
        cutoffDate.setTime(cutoffDate.getTime() - 5 * 60)

        let pendingExpiredPayments = await this.paymentModel.find(
            {
                status: 'pending',
                created: {
                    $lt: cutoffDate.toISOString()
                }
            }
        );
        console.log(pendingExpiredPayments);
        if (!pendingExpiredPayments.length) {
            console.log('No expired payments');
            return;
        }
        // get date range of payments...
        let minDate, maxDate;
        maxDate = cutoffDate;
        minDate = cutoffDate;
        let expiredPaymentsToSquareMap = new Map();
        pendingExpiredPayments.forEach((payment, index) => {
            // map reference ID to index...
            expiredPaymentsToSquareMap.set(payment._id.toString(), { index, isPresent: false});
            let curDate = new Date(payment.created);
            if ( curDate < minDate ) {
                minDate = curDate;
            }
        });
        console.log('Min date:', minDate);
        console.log('Cut off date', cutoffDate);

        // query Square for payment statuses...
        let result = await this.paymentsApi.listPayments(
            {
                'beginTime': minDate.toISOString(),
                'endTime': maxDate.toISOString(),
            }
        );
        let {payments, errors} = result;
        if ( errors && errors.length ) {
            // if there are errors, create a comprehensive error string
            let errorMessage = errors.reduce((accumulator, currentValue) => accumulator.concat(currentValue), '');
            throw new Error(errorMessage);
        }
        let paymentUpdatePromises = payments.reduce((accumulator, currentPayment) => {
            if ( expiredPaymentsToSquareMap.has(currentPayment.reference_id) ) {
                accumulator.push(
                    this.resolvePayment(
                        pendingExpiredPayments[expiredPaymentsToSquareMap.get(currentPayment.reference_id).index],
                        currentPayment,
                    )
                );
                expiredPaymentsToSquareMap.get(currentPayment.reference_id).isPresent = true;
            }
            return accumulator;
        }, []);
        // For each payment not present in Square's List Payments, set payment object's error status
        for (const [key, value] of expiredPaymentsToSquareMap.entries()) {
            if ( !value.isPresent ) {
                // if payment does not have an associated Square payment, set status to error.
                const expiredPayment = pendingExpiredPayments[value.index];
                expiredPayment.status = 'error';
                paymentUpdatePromises.push(
                    expiredPayment.save(),
                );
            }
        }

        return await Promise.all(paymentUpdatePromises);
    }

    async resolvePayment(paymentObject, squarePayment) {
        try {
            let modelUpdateFunction, data, errorModelUpdateFunction;
            data = paymentObject.actionData;
            switch(paymentObject.actionType) {
                case 'ArticleCreation':
                    modelUpdateFunction = this.createArticleUpdateFunction;
                    break;
            }
            let paymentUpdate, modelUpdate, errorUpdate;
            const session = await this.paymentModel.db.startSession();
            await session.withTransaction(async () => {
                if ( squarePayment.status === 'COMPLETED' ) {
                    // if Square payment success
                    modelUpdate = modelUpdateFunction(data, session);
                    paymentObject.status = 'done';
                    paymentObject.paymentId = squarePayment.id;
                } else if ( squarePayment.status !== 'APPROVED' ) {
                    // if payment not approved or completed...
                    if ( errorModelUpdateFunction ) {
                        errorUpdate = errorModelUpdateFunction(data, session);
                    }
                    paymentObject.status = 'error';
                }
                paymentObject.paymentActionId = squarePayment.id;
                paymentUpdate = paymentObject.save({session: session});
                // let all queries complete
                return await Promise.all([paymentUpdate, modelUpdate, errorUpdate]);
            });
            await session.endSession();
            return paymentUpdate;
        } catch (e) {
            console.log('Failed to resolve payment', payment._id);
        }
        return false;
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
        let articleCost = 100000;
        return await this.paymentsFactory(nonce, searchQuery, setQuery, articleCost, this.createArticleUpdateFunction);
    }
    
    async paymentsFactory(nonce, searchQuery, setQuery, paymentAmountUsd, modelUpdateFunction) {
        let paymentSearchQuery = {
            $or: [
                {
                    ...searchQuery,
                    status: 'pending'
                },
                {
                    ...searchQuery,
                    status: 'done'
                }
            ]
        };
        let paymentSetQuery = {
            ...setQuery,
            status: 'pending',
            paymentAmountUsd: paymentAmountUsd,
        };
        // create Payment object...
        let paymentObject = await this.paymentModel.findOneAndUpdate(
            paymentSearchQuery,
            {
                $setOnInsert: paymentSetQuery, // Set if no document matches searchQuery
            },
            {
                new: false, // returns null if new document
                upsert: true,
            }
        );
        // Presence of paymentObject means that there already exists a payment matching the searchQuery
        if ( paymentObject ) {
            throw new Error('Payment has either been done or is being processed');
        }
        // otherwise, retrieve newly created document
        paymentObject = await this.paymentModel.findOne( paymentSearchQuery );
        // perform payment
        let squarePayment;
        try {
            squarePayment = await this.makePayment(nonce, paymentAmountUsd, paymentObject._id.toString());
        } catch(e) {
            // on error...
            paymentObject.status = 'error';
            paymentObject.save();
            throw e;
        }
        // on success
        let session = await this.paymentModel.db.startSession();
        let paymentUpdate, modelUpdate;
        await session.withTransaction(async () => {
            paymentObject.paymentId = squarePayment.id;
            paymentObject.status = 'done';
            paymentUpdate = await paymentObject.save({session: session});
            console.log(paymentObject);
            modelUpdate = await modelUpdateFunction(paymentObject.actionData, session);
            return await Promise.all([
                paymentUpdate,
                modelUpdate,
            ]);
        });
        await session.endSession();
        return modelUpdate;
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
                    amount: amountInUsd,
                    currency: 'USD'
                },
                idempotency_key: idempotency_key,
                reference_id: referenceId,
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