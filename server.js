/**
 * Main controller logic
 */
// npm imports
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
// local imports
// models
const { ArticleModel } = require('./lib/articles/article.model');
const { PaymentModel } = require('./lib/payments/payment.model');
// services
const { ArticleService } = require('./lib/articles/article.service');
const { PaymentService } = require('./lib/payments/payment.service');

/**
 * Constants
 */
const PORT = 8080;
const articleService = new ArticleService();
const paymentService = new PaymentService();
/**
 * Connect to mongo db
 * https://mongoosejs.com/docs/connections.html
 */
mongoose.set('useFindAndModify', false);
mongoose
    .connect(`mongodb://username:password@host:port/database?options...`, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
        console.log('Database Connected');
    })
    .catch((err) => console.log(err));

/**
 * Express middlewares
 */
const app = express();
app.use(bodyParser.json()); // parse json data
app.use(bodyParser.urlencoded({ // parse urlencoded data
    extended: true
}));

/**
 * Method: GET
 * Resource: Article
 * Description: Gets a list of published articles
 */
app.get('/articles', (request, response, next) => {
    articleService
        .getArticles()
        .then((articles) => {
            if (!articles) {
                throw new Error('Could not get Articles');
            }
            response.status(200).send(articles);
        })
        .catch((e) => {
            next(e);
        });
});

/**
 * Method: POST
 * Resource: Article
 * Description: Publish an article if payments succeed.
 */
app.post('/articles/publish', (request, response, next) => {
    let { nonce, articleData } = request.body;
    // body validation
    if ( !nonce || !articleData ) {
        return next(new Error('Missing fields: nonce and articleData are required'));
    }
    if ( !articleData.title || !articleData.body ) {
        return next(new Error('Missing fields: articleData.title and articleData.body need to be set'));
    }
    // process article payment
    paymentService
        .createArticle(nonce, articleData)
        .then((status) => {
            if (!status) {
                throw new Error('Could not process article payment')
            }
            response.status(200).send('Success');
        })
        .catch((e) => {
            next(e);
        });
});

/**
 * Error handling:
 * https://expressjs.com/en/guide/error-handling.html
 */
app.use((error, request, response, next) => {
    let status = error.status || 500;
    let message = error.message || 'Something broke!';

    console.error(error.stack)
    response.status(status).send(message);
});

app.listen(PORT, () => {
    console.log(`Listening on port: ${PORT}`);
});
// Start CRON job
const msInterval = 1000 * 60 * 5; // run every 5 minutes
setInterval(async () => {
    console.log('Starting CRON job');
    return paymentService.startCronJob()
        .then(res => {
            if ( res ) 
                console.log(res);
        })
        .catch(error => {
            console.log('Error with CRON job: ', error);
        })
        .finally(() => {
            console.log('Finished CRON job');
        })
}, msInterval);