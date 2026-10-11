package com.ingredientapp.service;

/* Thrown when an external API can't be reached or rejects the request
   (network error, server error, or an invalid API key). Lets the controller
   send back "the service is unavailable" instead of an empty result, which the
   front-end would otherwise show as "no ingredients found". */
public class ApiUnavailableException extends RuntimeException {

    public ApiUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }

    public ApiUnavailableException(String message) {
        super(message);
    }
}
